import { createHash, randomUUID } from 'node:crypto';

import {
  deterministicUuid,
  MatchingEngine,
  type EngineConfig,
  type MatchingEvent,
  type OrderBookSnapshot,
  type OrderRejectedEvent,
  type TradeExecutedEvent,
} from '@commodity-chain/matching-core';
import {
  InsufficientBalanceError,
  PostgresLedger,
  type LedgerAccountId,
  type LedgerLegInput,
} from '@commodity-chain/ledger';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { canonicalizeJson } from '../oracle-gateway/canonical-json.js';
import { assertOrderAdmission } from './admission-policy.js';
import {
  assertNumeric38,
  calculateBuyReservation,
  calculateFee,
  calculateRemainingBuyReservation,
  type FeeRates,
} from './fee-calculator.js';
import { InstrumentCommandQueue } from './instrument-command-queue.js';
import { deserializeMatchingEvent, serializeMatchingEvent } from './matching-event-codec.js';
import { OmsError } from './oms.errors.js';
import type {
  CancelOrderCommand,
  OmsErrorBody,
  OmsExecutionResult,
  OrderBookView,
  OrderView,
  PlaceOrderCommand,
  SettlementView,
  TradeView,
} from './oms.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

interface InstrumentRow extends QueryResultRow {
  id: string;
  status: string;
  currency: string;
  unit: string;
  version: string;
}

interface BookRow extends QueryResultRow {
  instrument_id: string;
  tick_size: string;
  lot_size: string;
  self_trade_policy: 'CANCEL_NEWEST';
}

interface FeeScheduleRow extends QueryResultRow {
  version: string;
  currency: string;
  maker_rate_ppm: string;
  taker_rate_ppm: string;
}

interface OrderRow extends QueryResultRow {
  id: string;
  party_id: string;
  client_order_id: string;
  instrument_id: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price: string | null;
  quantity: string;
  open_quantity: string;
  status: string;
  fee_schedule_version: string | null;
  reservation_amount: string;
  reserved_remaining: string;
  executed_notional: string;
  charged_fee: string;
  matching_command_id: string | null;
  exchange_sequence_number: string | null;
  extensions: Readonly<Record<string, unknown>>;
  created_at: Date | string;
  updated_at: Date | string;
  accepted_at: Date | string | null;
  closed_at: Date | string | null;
}

interface AccountPair {
  readonly available: LedgerAccountId;
  readonly reserved: LedgerAccountId;
}

interface TradingContext {
  readonly instrument: InstrumentRow;
  readonly book: BookRow;
  readonly fee: FeeScheduleRow;
  readonly participantAccounts: AccountPair;
  readonly clearingCashReserved: LedgerAccountId;
  readonly clearingTokenReserved: LedgerAccountId;
}

interface StoredCommandRow extends QueryResultRow {
  request_hash: Buffer;
  order_id: string | null;
  http_status: number;
  response_body: OrderView | OmsErrorBody;
}

export class OmsService {
  public constructor(
    private readonly pool: Pool,
    private readonly ledger: PostgresLedger,
    private readonly queue: InstrumentCommandQueue,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async place(command: PlaceOrderCommand): Promise<OmsExecutionResult> {
    const validation = validatePlaceCommand(command);
    if (validation !== null) return resultFromError(validation, command.correlationId);
    const requestHash = orderRequestHash(command);

    return this.queue.run(command.instrumentId, () =>
      this.withTransaction(async (client) => {
        await lockBook(client, command.instrumentId);
        const replay = await this.findStoredCommand(
          client,
          command.idempotencyKey,
          requestHash,
          command.correlationId,
        );
        if (replay !== null) return replay;

        const duplicate = await this.findClientOrder(client, command);
        if (duplicate !== null) {
          await this.storeCommand(client, command, requestHash, duplicate);
          return { ...duplicate, replayed: true };
        }

        let context: TradingContext;
        try {
          context = await this.loadTradingContext(client, command);
        } catch (error: unknown) {
          if (!(error instanceof OmsError)) throw error;
          const failure = resultFromError(error, command.correlationId);
          await this.storeCommand(client, command, requestHash, failure);
          return failure;
        }

        const orderId = randomUUID();
        const matchingCommandId = randomUUID();
        let reservation: bigint;
        try {
          reservation =
            command.side === 'BUY'
              ? calculateBuyReservation(command.quantity, command.price!, feeRates(context.fee))
              : command.quantity;
        } catch (error: unknown) {
          if (!(error instanceof OmsError)) throw error;
          const failure = resultFromError(error, command.correlationId);
          await this.storeCommand(client, command, requestHash, failure);
          return failure;
        }

        let reservePostingId: string;
        try {
          const posting = await this.ledger.withinTransaction(client).reserve({
            idempotencyKey: `oms:order:${orderId}:reserve`,
            correlationId: command.correlationId,
            availableAccountId: context.participantAccounts.available,
            reservedAccountId: context.participantAccounts.reserved,
            amount: reservation,
            metadata: {
              operation: 'ORDER_RESERVE',
              orderId,
              instrumentId: command.instrumentId,
              side: command.side,
            },
          });
          reservePostingId = posting.id;
        } catch (error: unknown) {
          if (!(error instanceof InsufficientBalanceError)) throw error;
          const failure = resultFromError(
            new OmsError(
              'INSUFFICIENT_FUNDS',
              'Available ledger balance is insufficient for the order reserve',
              422,
            ),
            command.correlationId,
          );
          await this.storeCommand(client, command, requestHash, failure);
          return failure;
        }

        const createdAt = this.now().toISOString();
        await client.query(
          `
            INSERT INTO orders (
              id, party_id, client_order_id, instrument_id, side, type, price,
              quantity, open_quantity, status, extensions, fee_schedule_version,
              matching_command_id, reservation_amount, reserved_remaining,
              reserve_posting_id, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $8, 'VALIDATING', $9::jsonb,
              $10, $11, $12, $12, $13, $14, $14
            )
          `,
          [
            orderId,
            command.participantId,
            command.clientOrderId,
            command.instrumentId,
            command.side,
            command.type,
            command.price?.toString() ?? null,
            command.quantity.toString(),
            JSON.stringify(command.extensions ?? {}),
            context.fee.version,
            matchingCommandId,
            reservation.toString(),
            reservePostingId,
            createdAt,
          ],
        );

        const engine = await this.loadEngine(client, context.book);
        const events = engine.submitCommand({
          kind: 'PLACE',
          commandId: matchingCommandId,
          orderId,
          participantId: command.participantId,
          clientOrderId: command.clientOrderId,
          instrumentId: command.instrumentId,
          side: command.side,
          type: command.type,
          ...(command.price === undefined ? {} : { price: command.price }),
          quantity: command.quantity,
        });
        await this.applyEvents(
          client,
          command.instrumentId,
          events,
          orderId,
          command.correlationId,
        );

        const rejection = events.find(
          (event): event is OrderRejectedEvent => event.type === 'OrderRejected',
        );
        const response =
          rejection === undefined
            ? {
                httpStatus: 201,
                replayed: false,
                body: await this.readOrderView(client, orderId),
              }
            : resultFromError(matchingRejection(rejection), command.correlationId);
        await this.storeCommand(client, command, requestHash, response, orderId);
        return response;
      }),
    );
  }

  public async cancel(command: CancelOrderCommand): Promise<OmsExecutionResult> {
    const validation = validateCancelCommand(command);
    if (validation !== null) return resultFromError(validation, command.correlationId);
    const route = await this.pool.query<{ instrument_id: string } & QueryResultRow>(
      'SELECT instrument_id::text FROM orders WHERE id = $1 AND party_id = $2',
      [command.orderId, command.participantId],
    );
    const instrumentId = route.rows[0]?.instrument_id;
    if (instrumentId === undefined) {
      return resultFromError(
        new OmsError('RESOURCE_NOT_FOUND', `Order ${command.orderId} was not found`, 404),
        command.correlationId,
      );
    }

    return this.queue.run(instrumentId, () =>
      this.withTransaction(async (client) => {
        await lockBook(client, instrumentId);
        const order = await this.lockOrder(client, command.orderId);
        if (order.party_id !== command.participantId) {
          return resultFromError(
            new OmsError('RESOURCE_NOT_FOUND', `Order ${command.orderId} was not found`, 404),
            command.correlationId,
          );
        }
        if (order.status === 'CANCELLED') {
          return {
            httpStatus: 200,
            replayed: true,
            body: await this.readOrderView(client, order.id),
          };
        }
        if (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED') {
          return resultFromError(
            new OmsError(
              'ORDER_NOT_CANCELLABLE',
              `Order ${order.id} has no cancellable open remainder`,
              409,
            ),
            command.correlationId,
          );
        }

        const book = await this.requireBook(client, instrumentId);
        const engine = await this.loadEngine(client, book);
        const events = engine.submitCommand({
          kind: 'CANCEL',
          commandId: deterministicUuid(`oms:cancel:${order.id}:${command.participantId}`),
          orderId: order.id,
          participantId: command.participantId,
        });
        await this.applyEvents(client, instrumentId, events, undefined, command.correlationId);
        const rejection = events.find(
          (event): event is OrderRejectedEvent => event.type === 'OrderRejected',
        );
        return rejection === undefined
          ? { httpStatus: 200, replayed: false, body: await this.readOrderView(client, order.id) }
          : resultFromError(matchingRejection(rejection), command.correlationId);
      }),
    );
  }

  public async orderBook(instrumentId: string, depth: number): Promise<OrderBookView> {
    assertUuid(instrumentId, 'instrumentId');
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 100) {
      throw new OmsError('VALIDATION_ERROR', 'depth must be an integer from 1 to 100', 400);
    }
    return this.queue.run(instrumentId, () =>
      this.withTransaction(async (client) => {
        await lockBook(client, instrumentId);
        const book = await this.requireBook(client, instrumentId);
        return mapBook((await this.loadEngine(client, book)).getOrderBook(depth));
      }),
    );
  }

  private async loadTradingContext(
    client: PoolClient,
    command: PlaceOrderCommand,
  ): Promise<TradingContext> {
    const participant = await client.query('SELECT 1 FROM party WHERE id = $1', [
      command.participantId,
    ]);
    const instrumentResult = await client.query<InstrumentRow>(
      `SELECT id::text, status::text, currency, unit, version::text FROM instrument WHERE id = $1 FOR SHARE`,
      [command.instrumentId],
    );
    const instrument = instrumentResult.rows[0];
    assertOrderAdmission({
      participantId: command.participantId,
      participantExists: participant.rowCount !== 0,
      instrumentId: command.instrumentId,
      instrumentStatus: instrument?.status ?? null,
      tradeable: true,
    });
    const admittedInstrument = instrument!;

    await client.query(
      `
        INSERT INTO matching_books (
          instrument_id, passport_version, tick_size, lot_size, self_trade_policy
        )
        SELECT
          instrument.id,
          passport.version,
          (passport.passport #>> '{tradingParameters,tickSize}')::numeric(38,0),
          (passport.passport #>> '{tradingParameters,lotSize}')::numeric(38,0),
          'CANCEL_NEWEST'
        FROM instrument
        JOIN instrument_passport_versions AS passport
          ON passport.instrument_id = instrument.id
         AND passport.version = instrument.version
         AND passport.published_at IS NOT NULL
        WHERE instrument.id = $1
          AND (passport.passport #>> '{tradingParameters,tickSize}') ~ '^[1-9][0-9]{0,37}$'
          AND (passport.passport #>> '{tradingParameters,lotSize}') ~ '^[1-9][0-9]{0,37}$'
        ON CONFLICT (instrument_id) DO NOTHING
      `,
      [command.instrumentId],
    );
    const book = await this.requireBook(client, command.instrumentId);
    const feeResult = await client.query<FeeScheduleRow>(
      `
        SELECT version::text, currency, maker_rate_ppm::text, taker_rate_ppm::text
        FROM fee_schedules
        WHERE instrument_id = $1
          AND effective_from <= $2
          AND (effective_to IS NULL OR effective_to > $2)
        ORDER BY version DESC
        LIMIT 1
        FOR SHARE
      `,
      [command.instrumentId, this.now().toISOString()],
    );
    const fee = feeResult.rows[0];
    if (fee === undefined || fee.currency !== admittedInstrument.currency.trim()) {
      throw new OmsError(
        'INSTRUMENT_NOT_TRADABLE',
        'Instrument does not have an active fee schedule in its trading currency',
        422,
      );
    }
    const participantAccounts = await this.requireAccountPair(
      client,
      command.participantId,
      command.side,
      admittedInstrument,
    );
    const clearing = await client.query<
      QueryResultRow & { cash_reserved_account_id: string; token_reserved_account_id: string }
    >(
      `
        SELECT mapping.cash_reserved_account_id::text, mapping.token_reserved_account_id::text
        FROM oms_clearing_accounts AS mapping
        JOIN ledger_accounts AS cash ON cash.id = mapping.cash_reserved_account_id
        JOIN ledger_accounts AS token ON token.id = mapping.token_reserved_account_id
        WHERE mapping.instrument_id = $1
          AND cash.account_type = 'CASH'
          AND cash.currency = $2
          AND cash.purpose = 'RESERVED'
          AND cash.normal_side = 'DEBIT'
          AND token.account_type = 'TOKEN'
          AND token.instrument_id = $1
          AND token.purpose = 'RESERVED'
          AND token.normal_side = 'DEBIT'
      `,
      [command.instrumentId, admittedInstrument.currency.trim()],
    );
    const clearingRow = clearing.rows[0];
    if (clearingRow === undefined) {
      throw new OmsError(
        'INSTRUMENT_NOT_TRADABLE',
        'Instrument clearing accounts are not configured',
        422,
      );
    }
    return {
      instrument: admittedInstrument,
      book,
      fee,
      participantAccounts,
      clearingCashReserved: asAccountId(clearingRow.cash_reserved_account_id),
      clearingTokenReserved: asAccountId(clearingRow.token_reserved_account_id),
    };
  }

  private async requireAccountPair(
    client: PoolClient,
    participantId: string,
    side: 'BUY' | 'SELL',
    instrument: InstrumentRow,
  ): Promise<AccountPair> {
    const denominationPredicate =
      side === 'BUY'
        ? "account_type = 'CASH' AND currency = $2"
        : "account_type = 'TOKEN' AND instrument_id = $2";
    const denomination = side === 'BUY' ? instrument.currency.trim() : instrument.id;
    const result = await client.query<
      QueryResultRow & { id: string; purpose: 'AVAILABLE' | 'RESERVED'; normal_side: string }
    >(
      `
        SELECT id::text, purpose::text, normal_side::text
        FROM ledger_accounts
        WHERE owner_party_id = $1
          AND ${denominationPredicate}
          AND purpose IN ('AVAILABLE', 'RESERVED')
        ORDER BY purpose
      `,
      [participantId, denomination],
    );
    const available = result.rows.find((row) => row.purpose === 'AVAILABLE');
    const reserved = result.rows.find((row) => row.purpose === 'RESERVED');
    if (
      available === undefined ||
      reserved === undefined ||
      available.normal_side !== 'DEBIT' ||
      reserved.normal_side !== 'DEBIT'
    ) {
      throw new OmsError(
        'INSTRUMENT_NOT_TRADABLE',
        `Participant does not have the required ${side === 'BUY' ? 'cash' : 'token'} ledger accounts`,
        422,
      );
    }
    return { available: asAccountId(available.id), reserved: asAccountId(reserved.id) };
  }

  private async requireBook(client: PoolClient, instrumentId: string): Promise<BookRow> {
    const result = await client.query<BookRow>(
      `
        SELECT instrument_id::text, tick_size::text, lot_size::text, self_trade_policy
        FROM matching_books
        WHERE instrument_id = $1
      `,
      [instrumentId],
    );
    const book = result.rows[0];
    if (book === undefined) {
      throw new OmsError(
        'INSTRUMENT_NOT_TRADABLE',
        `Instrument ${instrumentId} has no immutable matching-book configuration`,
        422,
      );
    }
    return book;
  }

  private async loadEngine(client: PoolClient, book: BookRow): Promise<MatchingEngine> {
    const events = await client.query<{ payload: unknown } & QueryResultRow>(
      'SELECT payload FROM matching_events WHERE instrument_id = $1 ORDER BY sequence',
      [book.instrument_id],
    );
    const config: EngineConfig = {
      instrumentId: book.instrument_id,
      tickSize: BigInt(book.tick_size),
      lotSize: BigInt(book.lot_size),
      selfTradePolicy: book.self_trade_policy,
      clock: () => this.now().toISOString(),
    };
    return new MatchingEngine(
      config,
      events.rows.map((row) => deserializeMatchingEvent(row.payload)),
    );
  }

  private async applyEvents(
    client: PoolClient,
    instrumentId: string,
    events: readonly MatchingEvent[],
    placingOrderId: string | undefined,
    correlationId: string,
  ): Promise<void> {
    for (const event of events) {
      await this.persistMatchingEvent(client, instrumentId, event, correlationId);
      switch (event.type) {
        case 'OrderAccepted':
          await client.query(
            `
              UPDATE orders
              SET status = 'OPEN', exchange_sequence_number = $2,
                  accepted_at = $3, updated_at = $3
              WHERE id = $1
            `,
            [event.orderId, event.exchangeSequenceNumber.toString(), event.occurredAt],
          );
          break;
        case 'TradeExecuted':
          await this.applyTrade(client, event, correlationId);
          break;
        case 'OrderCancelled':
          await this.closeOrder(
            client,
            event.orderId,
            'CANCELLED',
            event.eventId,
            correlationId,
            event.occurredAt,
          );
          break;
        case 'OrderExpired':
          await this.closeOrder(
            client,
            event.orderId,
            'EXPIRED',
            event.eventId,
            correlationId,
            event.occurredAt,
          );
          break;
        case 'OrderRejected':
          if (event.orderId !== undefined && event.orderId === placingOrderId) {
            await this.rejectPlacedOrder(client, event, correlationId);
          }
          break;
      }
    }
  }

  private async persistMatchingEvent(
    client: PoolClient,
    instrumentId: string,
    event: MatchingEvent,
    correlationId: string,
  ): Promise<void> {
    const payload = serializeMatchingEvent(event);
    await client.query(
      `
        INSERT INTO matching_events (
          instrument_id, sequence, event_id, exchange_sequence_number,
          event_index, event_count, command_id, event_type, payload, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      `,
      [
        instrumentId,
        event.nonce.toString(),
        event.eventId,
        event.exchangeSequenceNumber.toString(),
        event.eventIndex,
        event.eventCount,
        event.commandId,
        event.type,
        JSON.stringify(payload),
        event.occurredAt,
      ],
    );
    await client.query(
      `
        INSERT INTO event_log (
          occurred_at, actor, event_type, aggregate_type,
          aggregate_id, correlation_id, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        event.occurredAt,
        `matching:${instrumentId}`,
        `MATCHING_${event.type}`,
        event.type === 'TradeExecuted' ? 'TRADE' : 'ORDER',
        event.type === 'TradeExecuted' ? event.tradeId : (event.orderId ?? event.commandId),
        correlationId,
        JSON.stringify(payload),
      ],
    );
  }

  private async applyTrade(
    client: PoolClient,
    event: TradeExecutedEvent,
    correlationId: string,
  ): Promise<void> {
    const buy = await this.lockOrder(client, event.buyOrderId);
    const sell = await this.lockOrder(client, event.sellOrderId);
    if (buy.price === null || buy.fee_schedule_version === null) {
      throw new Error(`BUY order ${buy.id} does not have price or fee schedule`);
    }
    const oldBuyOpen = BigInt(buy.open_quantity);
    const oldSellOpen = BigInt(sell.open_quantity);
    const newBuyOpen = oldBuyOpen - event.quantity;
    const newSellOpen = oldSellOpen - event.quantity;
    if (newBuyOpen < 0n || newSellOpen < 0n)
      throw new Error('Trade exceeds persisted open quantity');

    const fee = await this.loadFixedFee(client, buy.instrument_id, buy.fee_schedule_version);
    const rates = feeRates(fee);
    const targetBuyReserve = calculateRemainingBuyReservation(newBuyOpen, BigInt(buy.price), rates);
    const buyReserveBefore = BigInt(buy.reserved_remaining);
    const buyReduction = buyReserveBefore - targetBuyReserve;
    const notional = assertNumeric38(event.price * event.quantity, 'tradeNotional');
    const worstRate =
      rates.makerRatePpm > rates.takerRatePpm ? rates.makerRatePpm : rates.takerRatePpm;
    const executedNotional = assertNumeric38(
      BigInt(buy.executed_notional) + notional,
      'executedNotional',
    );
    const cumulativeFee = calculateFee(executedNotional, worstRate);
    const feeDue = cumulativeFee - BigInt(buy.charged_fee);
    const maximumFeeThisFill = buyReduction - notional;
    const actualFee = feeDue < maximumFeeThisFill ? feeDue : maximumFeeThisFill;
    const priceImprovement = maximumFeeThisFill - actualFee;
    if (buyReduction < 0n || feeDue < 0n || maximumFeeThisFill < 0n) {
      throw new Error(`BUY order ${buy.id} reserve allocation is inconsistent`);
    }

    const buyerAccounts = await this.requireAccountPairByOrder(client, buy);
    const sellerAccounts = await this.requireAccountPairByOrder(client, sell);
    const clearing = await this.requireClearingAccounts(client, event.instrumentId);
    const ledger = this.ledger.withinTransaction(client);
    const cashLegs: LedgerLegInput[] = [
      { accountId: buyerAccounts.reserved, direction: 'CREDIT', amount: buyReduction },
      {
        accountId: clearing.cash,
        direction: 'DEBIT',
        amount: notional + actualFee,
      },
    ];
    if (priceImprovement > 0n) {
      cashLegs.push({
        accountId: buyerAccounts.available,
        direction: 'DEBIT',
        amount: priceImprovement,
      });
    }
    await ledger.post({
      idempotencyKey: `oms:trade:${event.tradeId}:cash`,
      correlationId,
      legs: asLegTuple(cashLegs),
      metadata: { operation: 'TRADE_CASH_COMMITMENT', tradeId: event.tradeId },
    });
    await ledger.post({
      idempotencyKey: `oms:trade:${event.tradeId}:token`,
      correlationId,
      legs: [
        { accountId: sellerAccounts.reserved, direction: 'CREDIT', amount: event.quantity },
        { accountId: clearing.token, direction: 'DEBIT', amount: event.quantity },
      ],
      metadata: { operation: 'TRADE_TOKEN_COMMITMENT', tradeId: event.tradeId },
    });

    await this.updateFilledOrder(client, buy, newBuyOpen, targetBuyReserve, event.occurredAt, {
      executedNotional,
      chargedFee: BigInt(buy.charged_fee) + actualFee,
    });
    await this.updateFilledOrder(
      client,
      sell,
      newSellOpen,
      BigInt(sell.reserved_remaining) - event.quantity,
      event.occurredAt,
    );
    await client.query(
      `
        INSERT INTO trades (
          trade_id, buy_order_id, sell_order_id, instrument_id,
          price, quantity, executed_at, matching_event_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        event.tradeId,
        event.buyOrderId,
        event.sellOrderId,
        event.instrumentId,
        event.price.toString(),
        event.quantity.toString(),
        event.occurredAt,
        event.eventId,
      ],
    );
    const instrument = await client.query<InstrumentRow>(
      'SELECT id::text, status::text, currency, unit, version::text FROM instrument WHERE id = $1',
      [event.instrumentId],
    );
    const instrumentRow = requireRow(instrument.rows[0], 'Trade instrument was not found');
    await client.query(
      `
        INSERT INTO settlements (
          trade_id, cash_currency, cash_amount, cash_payer_party_id,
          cash_payee_party_id, token_instrument_id, token_quantity,
          token_from_party_id, token_to_party_id, finality_status, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $5, $4, 'CREATED', $8)
      `,
      [
        event.tradeId,
        instrumentRow.currency.trim(),
        notional.toString(),
        buy.party_id,
        sell.party_id,
        event.instrumentId,
        event.quantity.toString(),
        event.occurredAt,
      ],
    );
    if (actualFee > 0n) {
      await client.query(
        `
          INSERT INTO settlement_fees (settlement_id, fee_type, currency, amount)
          VALUES ($1, 'TRADING', $2, $3)
        `,
        [event.tradeId, instrumentRow.currency.trim(), actualFee.toString()],
      );
    }
  }

  private async closeOrder(
    client: PoolClient,
    orderId: string,
    status: 'CANCELLED' | 'EXPIRED',
    eventId: string,
    correlationId: string,
    occurredAt: string,
  ): Promise<void> {
    const order = await this.lockOrder(client, orderId);
    const remaining = BigInt(order.reserved_remaining);
    if (remaining > 0n) {
      const accounts = await this.requireAccountPairByOrder(client, order);
      await this.ledger.withinTransaction(client).release({
        idempotencyKey: `oms:${status.toLowerCase()}:${eventId}:release`,
        correlationId,
        availableAccountId: accounts.available,
        reservedAccountId: accounts.reserved,
        amount: remaining,
        metadata: { operation: `ORDER_${status}_RELEASE`, orderId },
      });
    }
    await client.query(
      `
        UPDATE orders
        SET open_quantity = 0, reserved_remaining = 0, status = $2,
            updated_at = $3, closed_at = $3
        WHERE id = $1
      `,
      [orderId, status, occurredAt],
    );
  }

  private async rejectPlacedOrder(
    client: PoolClient,
    event: OrderRejectedEvent,
    correlationId: string,
  ): Promise<void> {
    const order = await this.lockOrder(client, event.orderId!);
    const remaining = BigInt(order.reserved_remaining);
    if (remaining > 0n) {
      const accounts = await this.requireAccountPairByOrder(client, order);
      await this.ledger.withinTransaction(client).release({
        idempotencyKey: `oms:reject:${event.eventId}:release`,
        correlationId,
        availableAccountId: accounts.available,
        reservedAccountId: accounts.reserved,
        amount: remaining,
        metadata: { operation: 'ORDER_REJECTED_RELEASE', orderId: order.id },
      });
    }
    await client.query(
      `
        UPDATE orders
        SET open_quantity = 0, reserved_remaining = 0, status = 'REJECTED',
            rejection_code = $2, updated_at = $3, closed_at = $3
        WHERE id = $1
      `,
      [order.id, event.reason, event.occurredAt],
    );
  }

  private async updateFilledOrder(
    client: PoolClient,
    order: OrderRow,
    openQuantity: bigint,
    reserveRemaining: bigint,
    occurredAt: string,
    execution?: { readonly executedNotional: bigint; readonly chargedFee: bigint },
  ): Promise<void> {
    if (reserveRemaining < 0n) throw new Error(`Order ${order.id} reserve became negative`);
    await client.query(
      `
        UPDATE orders
        SET open_quantity = $2, reserved_remaining = $3,
            status = $4, updated_at = $5,
            executed_notional = $6, charged_fee = $7,
            closed_at = CASE WHEN $2::numeric = 0 THEN $5::timestamptz ELSE closed_at END
        WHERE id = $1
      `,
      [
        order.id,
        openQuantity.toString(),
        reserveRemaining.toString(),
        openQuantity === 0n ? 'FILLED' : 'PARTIALLY_FILLED',
        occurredAt,
        execution?.executedNotional.toString() ?? order.executed_notional,
        execution?.chargedFee.toString() ?? order.charged_fee,
      ],
    );
  }

  private async requireAccountPairByOrder(
    client: PoolClient,
    order: OrderRow,
  ): Promise<AccountPair> {
    const instrument = await client.query<InstrumentRow>(
      'SELECT id::text, status::text, currency, unit, version::text FROM instrument WHERE id = $1',
      [order.instrument_id],
    );
    return this.requireAccountPair(
      client,
      order.party_id,
      order.side,
      requireRow(instrument.rows[0], 'Order instrument was not found'),
    );
  }

  private async requireClearingAccounts(
    client: PoolClient,
    instrumentId: string,
  ): Promise<{ readonly cash: LedgerAccountId; readonly token: LedgerAccountId }> {
    const result = await client.query<
      QueryResultRow & { cash_reserved_account_id: string; token_reserved_account_id: string }
    >(
      `SELECT cash_reserved_account_id::text, token_reserved_account_id::text
       FROM oms_clearing_accounts WHERE instrument_id = $1`,
      [instrumentId],
    );
    const row = requireRow(result.rows[0], 'Clearing accounts were not found');
    return {
      cash: asAccountId(row.cash_reserved_account_id),
      token: asAccountId(row.token_reserved_account_id),
    };
  }

  private async loadFixedFee(
    client: PoolClient,
    instrumentId: string,
    version: string,
  ): Promise<FeeScheduleRow> {
    const result = await client.query<FeeScheduleRow>(
      `SELECT version::text, currency, maker_rate_ppm::text, taker_rate_ppm::text
       FROM fee_schedules WHERE instrument_id = $1 AND version = $2`,
      [instrumentId, version],
    );
    return requireRow(result.rows[0], `Fee schedule ${instrumentId}/${version} was not found`);
  }

  private async lockOrder(client: PoolClient, orderId: string): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = result.rows[0];
    if (order === undefined)
      throw new OmsError('RESOURCE_NOT_FOUND', `Order ${orderId} was not found`, 404);
    return order;
  }

  private async readOrderView(client: PoolClient, orderId: string): Promise<OrderView> {
    const result = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [orderId],
    );
    const order = requireRow(result.rows[0], `Order ${orderId} was not found`);
    const trades = await client.query<
      QueryResultRow & {
        trade_id: string;
        buy_order_id: string;
        sell_order_id: string;
        instrument_id: string;
        price: string;
        quantity: string;
        executed_at: Date | string;
        cash_currency: string;
        cash_amount: string;
        cash_payer_party_id: string;
        cash_payee_party_id: string;
        token_quantity: string;
        token_from_party_id: string;
        token_to_party_id: string;
        unit: string;
        finality_status: string;
        settlement_updated_at: Date | string;
        settlement_extensions: Readonly<Record<string, unknown>>;
      }
    >(
      `
        SELECT
          trade.trade_id::text, trade.buy_order_id::text, trade.sell_order_id::text,
          trade.instrument_id::text, trade.price::text, trade.quantity::text, trade.executed_at,
          settlement.cash_currency, settlement.cash_amount::text,
          settlement.cash_payer_party_id::text, settlement.cash_payee_party_id::text,
          settlement.token_quantity::text, settlement.token_from_party_id::text,
          settlement.token_to_party_id::text, instrument.unit,
          settlement.finality_status::text, settlement.updated_at AS settlement_updated_at,
          settlement.extensions AS settlement_extensions
        FROM trades AS trade
        JOIN settlements AS settlement ON settlement.trade_id = trade.trade_id
        JOIN instrument ON instrument.id = trade.instrument_id
        WHERE trade.buy_order_id = $1 OR trade.sell_order_id = $1
        ORDER BY trade.executed_at, trade.trade_id
      `,
      [orderId],
    );
    const tradeViews: TradeView[] = [];
    for (const trade of trades.rows) {
      const fees = await client.query<
        QueryResultRow & { fee_type: string; currency: string; amount: string }
      >(
        `SELECT fee_type, currency, amount::text FROM settlement_fees WHERE settlement_id = $1 ORDER BY id`,
        [trade.trade_id],
      );
      const settlement: SettlementView = {
        tradeId: trade.trade_id,
        cashLeg: {
          currency: trade.cash_currency.trim(),
          amount: trade.cash_amount,
          payer: trade.cash_payer_party_id,
          payee: trade.cash_payee_party_id,
        },
        tokenLeg: {
          instrumentId: trade.instrument_id,
          quantity: trade.token_quantity,
          unit: trade.unit,
          from: trade.token_from_party_id,
          to: trade.token_to_party_id,
        },
        fees: fees.rows.map((fee) => ({
          feeType: fee.fee_type,
          currency: fee.currency.trim(),
          amount: fee.amount,
        })),
        finalityStatus: trade.finality_status,
        updatedAt: toIso(trade.settlement_updated_at),
        extensions: trade.settlement_extensions,
      };
      tradeViews.push({
        tradeId: trade.trade_id,
        buyOrderId: trade.buy_order_id,
        sellOrderId: trade.sell_order_id,
        instrumentId: trade.instrument_id,
        price: trade.price,
        quantity: trade.quantity,
        executedAt: toIso(trade.executed_at),
        settlement,
      });
    }
    if (order.fee_schedule_version === null)
      throw new Error(`Order ${order.id} has no fee schedule`);
    return {
      id: order.id,
      clientOrderId: order.client_order_id,
      instrumentId: order.instrument_id,
      side: order.side,
      type: order.type,
      ...(order.price === null ? {} : { price: order.price }),
      quantity: order.quantity,
      openQuantity: order.open_quantity,
      status: order.status,
      feeScheduleVersion: safeVersion(order.fee_schedule_version),
      trades: tradeViews,
      createdAt: toIso(order.created_at),
      updatedAt: toIso(order.updated_at),
      ...(order.accepted_at === null ? {} : { acceptedAt: toIso(order.accepted_at) }),
      ...(order.closed_at === null ? {} : { closedAt: toIso(order.closed_at) }),
      extensions: order.extensions,
    };
  }

  private async findStoredCommand(
    client: PoolClient,
    idempotencyKey: string,
    requestHash: Buffer,
    correlationId: string,
  ): Promise<OmsExecutionResult | null> {
    const result = await client.query<StoredCommandRow>(
      'SELECT request_hash, order_id::text, http_status, response_body FROM order_commands WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    const stored = result.rows[0];
    if (stored === undefined) return null;
    if (!stored.request_hash.equals(requestHash)) {
      return resultFromError(
        new OmsError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used for a different order request',
          409,
        ),
        correlationId,
      );
    }
    return { httpStatus: stored.http_status, replayed: true, body: stored.response_body };
  }

  private async findClientOrder(
    client: PoolClient,
    command: PlaceOrderCommand,
  ): Promise<OmsExecutionResult | null> {
    const result = await client.query<StoredCommandRow>(
      `
        SELECT command.request_hash, command.order_id::text,
               command.http_status, command.response_body
        FROM orders AS orders
        JOIN order_commands AS command ON command.order_id = orders.id
        WHERE orders.party_id = $1 AND orders.client_order_id = $2
        ORDER BY command.created_at
        LIMIT 1
      `,
      [command.participantId, command.clientOrderId],
    );
    const stored = result.rows[0];
    return stored === undefined
      ? null
      : { httpStatus: stored.http_status, replayed: true, body: stored.response_body };
  }

  private async storeCommand(
    client: PoolClient,
    command: PlaceOrderCommand,
    requestHash: Buffer,
    result: OmsExecutionResult,
    orderId?: string,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO order_commands (
          idempotency_key, request_hash, participant_id, order_id, http_status, response_body
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        command.idempotencyKey,
        requestHash,
        command.participantId,
        orderId ?? ('id' in result.body ? result.body.id : null),
        result.httpStatus,
        JSON.stringify(result.body),
      ],
    );
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

const ORDER_COLUMNS = `
  id::text, party_id::text, client_order_id, instrument_id::text,
  side::text, type::text, price::text, quantity::text, open_quantity::text,
  status::text, fee_schedule_version::text, reservation_amount::text,
  reserved_remaining::text, executed_notional::text, charged_fee::text,
  matching_command_id::text,
  exchange_sequence_number::text, extensions, created_at, updated_at,
  accepted_at, closed_at
`;

function validatePlaceCommand(command: PlaceOrderCommand): OmsError | null {
  try {
    assertUuid(command.participantId, 'participantId');
    assertUuid(command.instrumentId, 'instrumentId');
    assertUuid(command.correlationId, 'correlationId');
  } catch (error: unknown) {
    return error as OmsError;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)) {
    return validationError('idempotencyKey', 'Idempotency-Key is invalid');
  }
  if (command.clientOrderId.length === 0 || command.clientOrderId.length > 128) {
    return validationError('clientOrderId', 'clientOrderId must contain 1 to 128 characters');
  }
  if (command.type !== 'LIMIT') {
    return new OmsError('ORDER_TYPE_NOT_AVAILABLE', 'Only LIMIT orders are available', 422);
  }
  if (command.side !== 'BUY' && command.side !== 'SELL') {
    return validationError('side', 'side must be BUY or SELL');
  }
  if (typeof command.price !== 'bigint' || command.price <= 0n) {
    return validationError('price', 'LIMIT price must be a positive bigint in minor units');
  }
  if (typeof command.quantity !== 'bigint' || command.quantity <= 0n) {
    return validationError('quantity', 'quantity must be a positive bigint in minor units');
  }
  try {
    assertNumeric38(command.price, 'price');
    assertNumeric38(command.quantity, 'quantity');
  } catch (error: unknown) {
    return error as OmsError;
  }
  return null;
}

function validateCancelCommand(command: CancelOrderCommand): OmsError | null {
  try {
    assertUuid(command.participantId, 'participantId');
    assertUuid(command.orderId, 'orderId');
    assertUuid(command.correlationId, 'correlationId');
    return null;
  } catch (error: unknown) {
    return error as OmsError;
  }
}

function orderRequestHash(command: PlaceOrderCommand): Buffer {
  const canonical = canonicalizeJson({
    participantId: command.participantId,
    clientOrderId: command.clientOrderId,
    instrumentId: command.instrumentId,
    side: command.side,
    type: command.type,
    price: command.price?.toString(),
    quantity: command.quantity.toString(),
    extensions: command.extensions ?? {},
  });
  return createHash('sha256').update(canonical, 'utf8').digest();
}

function feeRates(row: FeeScheduleRow): FeeRates {
  return { makerRatePpm: BigInt(row.maker_rate_ppm), takerRatePpm: BigInt(row.taker_rate_ppm) };
}

function matchingRejection(event: OrderRejectedEvent): OmsError {
  if (event.reason === 'ORDER_TYPE_NOT_AVAILABLE') {
    return new OmsError('ORDER_TYPE_NOT_AVAILABLE', event.message, 422);
  }
  if (event.reason === 'ORDER_NOT_CANCELLABLE') {
    return new OmsError('ORDER_NOT_CANCELLABLE', event.message, 409);
  }
  return new OmsError('ORDER_REJECTED', event.message, 422, [
    { reason: event.message, metadata: { matchingReason: event.reason } },
  ]);
}

function resultFromError(error: OmsError, correlationId: string): OmsExecutionResult {
  return {
    httpStatus: error.httpStatus,
    replayed: false,
    body: {
      code: error.code,
      message: error.message,
      correlationId,
      details: error.details,
    },
  };
}

function validationError(field: string, reason: string): OmsError {
  return new OmsError('VALIDATION_ERROR', reason, 400, [{ field, reason }]);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validationError(field, `${field} must be a UUID`);
  }
}

function asAccountId(value: string): LedgerAccountId {
  return value as LedgerAccountId;
}

function asLegTuple(
  legs: readonly LedgerLegInput[],
): readonly [LedgerLegInput, LedgerLegInput, ...LedgerLegInput[]] {
  if (legs.length < 2) throw new Error('A ledger posting requires at least two legs');
  return [legs[0]!, legs[1]!, ...legs.slice(2)];
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error(`Invalid version ${value}`);
  return version;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function lockBook(client: PoolClient, instrumentId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `oms-book:${instrumentId}`,
  ]);
}

function mapBook(snapshot: OrderBookSnapshot): OrderBookView {
  return {
    instrumentId: snapshot.instrumentId,
    sequence: snapshot.sequence.toString(),
    snapshotAt: snapshot.snapshotAt,
    bids: snapshot.bids.map((level) => ({
      price: level.price.toString(),
      quantity: level.quantity.toString(),
      orderCount: level.orderCount,
    })),
    asks: snapshot.asks.map((level) => ({
      price: level.price.toString(),
      quantity: level.quantity.toString(),
      orderCount: level.orderCount,
    })),
  };
}

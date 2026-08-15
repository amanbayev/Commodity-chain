import { randomUUID } from 'node:crypto';

import { MatchingEngine, type EngineConfig } from '@commodity-chain/matching-core';
import { PostgresLedger, type LedgerAccountId } from '@commodity-chain/ledger';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { InstrumentCommandQueue } from './instrument-command-queue.js';
import { deserializeMatchingEvent } from './matching-event-codec.js';
import { OmsService } from './oms.service.js';
import type { OmsExecutionResult, OrderView, PlaceOrderCommand } from './oms.types.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('OMS PostgreSQL integration', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 30 });
  const ledger = new PostgresLedger(pool);
  let service: OmsService;
  let fixture: Fixture;

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        settlement_fees,
        settlements,
        trades,
        order_commands,
        matching_events,
        orders,
        oms_clearing_accounts,
        fee_schedules,
        matching_books,
        ledger_entries,
        ledger_postings,
        ledger_accounts,
        instrument_review_decisions,
        instrument_status_transitions,
        instrument_passport_versions,
        outbox,
        event_log,
        instrument,
        party
      RESTART IDENTITY CASCADE
    `);
    service = new OmsService(pool, ledger, new InstrumentCommandQueue());
    fixture = await createFixture(100_000n, 10_000n);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('executes BUY and SELL, moves reserves, and creates one settlement obligation', async () => {
    const sell = await service.place(order(fixture.sellerId, 'SELL', 100n, 50n, 'sell-full'));
    expect(orderResult(sell)).toMatchObject({ status: 'OPEN', openQuantity: '50' });
    await assertActiveReserveInvariant(fixture.sellerId, 'SELL');

    const buy = await service.place(order(fixture.buyerId, 'BUY', 110n, 50n, 'buy-full'));
    const buyOrder = orderResult(buy);
    expect(buyOrder).toMatchObject({ status: 'FILLED', openQuantity: '0' });
    expect(buyOrder.trades).toHaveLength(1);
    expect(buyOrder.trades[0]).toMatchObject({ price: '100', quantity: '50' });
    expect(buyOrder.trades[0]?.settlement).toMatchObject({
      finalityStatus: 'CREATED',
      cashLeg: { amount: '5000', payer: fixture.buyerId, payee: fixture.sellerId },
      tokenLeg: { quantity: '50', from: fixture.sellerId, to: fixture.buyerId },
    });
    expect(buyOrder.trades[0]?.settlement.fees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feeType: 'SELLER_ROUNDING_RESIDUAL', amount: '1' }),
        expect.objectContaining({ feeType: 'BUYER_TRADING_FEE', amount: '5' }),
        expect.objectContaining({ feeType: 'SELLER_TRADING_FEE', amount: '2' }),
      ]),
    );

    expect(await count('trades')).toBe(1n);
    expect(await count('settlements')).toBe(1n);
    expect(await count('matching_events', "event_type = 'TradeExecuted'")).toBe(1n);
    expect(await accountBalance(fixture.buyerCashReserved)).toBe(0n);
    expect(await accountBalance(fixture.sellerTokenReserved)).toBe(0n);
    expect(await accountBalance(fixture.clearingCashReserved)).toBe(5_005n);
    expect(await accountBalance(fixture.clearingTokenReserved)).toBe(50n);
    expect(await accountBalance(fixture.buyerCashAvailable)).toBe(94_995n);
    await assertActiveReserveInvariant(fixture.buyerId, 'BUY');
    await assertActiveReserveInvariant(fixture.sellerId, 'SELL');
    const eventCountBeforeCancel = await count('matching_events');
    const filledCancel = await service.cancel({
      participantId: fixture.buyerId,
      orderId: buyOrder.id,
      correlationId: randomUUID(),
    });
    expect(errorCode(filledCancel)).toBe('ORDER_NOT_CANCELLABLE');
    expect(await count('matching_events')).toBe(eventCountBeforeCancel);
    await assertReplayMatchesBook();
  });

  it('keeps proportional reserve after partial fill and releases it idempotently on cancel', async () => {
    await service.place(order(fixture.sellerId, 'SELL', 100n, 30n, 'sell-partial'));
    const buy = orderResult(
      await service.place(order(fixture.buyerId, 'BUY', 110n, 50n, 'buy-partial')),
    );
    expect(buy).toMatchObject({ status: 'PARTIALLY_FILLED', openQuantity: '20' });
    expect(await reservedRemaining(buy.id)).toBe(2_203n);
    expect(await accountBalance(fixture.buyerCashReserved)).toBe(2_203n);
    await assertActiveReserveInvariant(fixture.buyerId, 'BUY');

    const cancelled = await service.cancel({
      participantId: fixture.buyerId,
      orderId: buy.id,
      correlationId: randomUUID(),
    });
    expect(orderResult(cancelled)).toMatchObject({ status: 'CANCELLED', openQuantity: '0' });
    const replayed = await service.cancel({
      participantId: fixture.buyerId,
      orderId: buy.id,
      correlationId: randomUUID(),
    });
    expect(replayed.replayed).toBe(true);
    expect(orderResult(replayed).status).toBe('CANCELLED');
    expect(await accountBalance(fixture.buyerCashReserved)).toBe(0n);
    expect(
      await count('ledger_postings', "metadata ->> 'operation' = 'ORDER_CANCELLED_RELEASE'"),
    ).toBe(1n);
    await assertActiveReserveInvariant(fixture.buyerId, 'BUY');
    await assertReplayMatchesBook();
  });

  it('accrues rounded commission cumulatively across fragmented fills', async () => {
    for (let index = 0; index < 3; index += 1) {
      await service.place(order(fixture.sellerId, 'SELL', 10n, 10n, `fragment-sell-${index}`));
    }
    const buy = orderResult(
      await service.place(order(fixture.buyerId, 'BUY', 10n, 30n, 'fragment-buy')),
    );
    expect(buy.status).toBe('FILLED');
    expect(buy.trades).toHaveLength(3);
    const fee = await pool.query<{ buyer_total: string; seller_total: string }>(
      `SELECT
         coalesce(sum(amount) FILTER (WHERE fee_type LIKE 'BUYER%'), 0)::text AS buyer_total,
         coalesce(sum(amount) FILTER (WHERE fee_type LIKE 'SELLER%'), 0)::text AS seller_total
       FROM settlement_fees`,
    );
    expect(fee.rows[0]).toEqual({ buyer_total: '1', seller_total: '3' });
    expect(await accountBalance(fixture.buyerCashReserved)).toBe(0n);
    expect(await accountBalance(fixture.clearingCashReserved)).toBe(301n);
    await assertActiveReserveInvariant(fixture.buyerId, 'BUY');
  });

  it('rejects insufficient funds without creating an order or reserve posting', async () => {
    const result = await service.place(
      order(fixture.buyerId, 'BUY', 1_000n, 1_000n, 'too-expensive'),
    );
    expect(errorCode(result)).toBe('INSUFFICIENT_FUNDS');
    expect(await count('orders')).toBe(0n);
    expect(await count('ledger_postings', "metadata ->> 'operation' = 'ORDER_RESERVE'")).toBe(0n);
    expect(await accountBalance(fixture.buyerCashReserved)).toBe(0n);
  });

  it('persists matching rejection and fully releases its reserve', async () => {
    const result = await service.place(order(fixture.buyerId, 'BUY', 101n, 10n, 'off-tick'));
    expect(errorCode(result)).toBe('ORDER_REJECTED');
    expect(await count('orders', "status = 'REJECTED'")).toBe(1n);
    expect(await count('matching_events', "event_type = 'OrderRejected'")).toBe(1n);
    expect(await accountBalance(fixture.buyerCashReserved)).toBe(0n);
    expect(await count('ledger_postings', "metadata ->> 'operation' = 'ORDER_RESERVE'")).toBe(1n);
    expect(
      await count('ledger_postings', "metadata ->> 'operation' = 'ORDER_REJECTED_RELEASE'"),
    ).toBe(1n);
  });

  it('replays one POST one hundred times as one order and one reserve', async () => {
    const command = order(fixture.buyerId, 'BUY', 90n, 10n, 'idempotent-buy');
    const first = await service.place(command);
    expect(first.httpStatus).toBe(201);
    for (let replay = 0; replay < 100; replay += 1) {
      const result = await service.place(command);
      expect(result.replayed).toBe(true);
      expect(result.body).toEqual(first.body);
    }
    expect(await count('orders')).toBe(1n);
    expect(await count('ledger_postings', "metadata ->> 'operation' = 'ORDER_RESERVE'")).toBe(1n);
    expect(await count('matching_events')).toBe(1n);
    const conflict = await service.place({ ...command, quantity: 20n });
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_KEY_REUSED');
    const duplicateClientOrder = await service.place({
      ...command,
      idempotencyKey: `duplicate-client-${randomUUID()}`,
      quantity: 20n,
    });
    expect(duplicateClientOrder.replayed).toBe(true);
    expect(duplicateClientOrder.body).toEqual(first.body);
    expect(await count('orders')).toBe(1n);
    await assertActiveReserveInvariant(fixture.buyerId, 'BUY');
  });

  it('serializes parallel commands for one book without crossing or reserve drift', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.place(order(fixture.buyerId, 'BUY', 90n, 10n, `parallel-${index}`)),
      ),
    );
    expect(results.every((result) => result.httpStatus === 201)).toBe(true);
    expect(await count('orders')).toBe(20n);
    expect(await count('matching_events')).toBe(20n);
    const sequences = await pool.query<{ sequences: string; maximum: string }>(`
      SELECT count(DISTINCT exchange_sequence_number)::text AS sequences,
             max(exchange_sequence_number)::text AS maximum
      FROM matching_events
    `);
    expect(sequences.rows[0]).toEqual({ sequences: '20', maximum: '20' });
    await assertActiveReserveInvariant(fixture.buyerId, 'BUY');
    const book = await service.orderBook(fixture.instrumentId, 20);
    expect(book.bids).toEqual([{ price: '90', quantity: '200', orderCount: 20 }]);
    expect(book.asks).toEqual([]);
    await assertReplayMatchesBook();
  });

  interface Fixture {
    readonly instrumentId: string;
    readonly buyerId: string;
    readonly sellerId: string;
    readonly buyerCashAvailable: LedgerAccountId;
    readonly buyerCashReserved: LedgerAccountId;
    readonly sellerTokenReserved: LedgerAccountId;
    readonly clearingCashReserved: LedgerAccountId;
    readonly clearingTokenReserved: LedgerAccountId;
  }

  async function createFixture(cash: bigint, tokens: bigint): Promise<Fixture> {
    const instrumentId = randomUUID();
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const clearingId = randomUUID();
    const fundingId = randomUUID();
    await pool.query(
      `INSERT INTO party (id, external_id) VALUES
        ($1, $5), ($2, $6), ($3, $7), ($4, $8)`,
      [
        buyerId,
        sellerId,
        clearingId,
        fundingId,
        `buyer-${buyerId}`,
        `seller-${sellerId}`,
        `clearing-${clearingId}`,
        `funding-${fundingId}`,
      ],
    );
    const hash = `sha256:${'1'.repeat(64)}`;
    await pool.query(
      `
        INSERT INTO instrument (
          id, type, legal_nature, status, currency, unit, unit_per_token,
          supply_cap, version, passport_hash
        ) VALUES ($1, 'GRAIN_TOKEN', 'CLAIM_RIGHT', 'ACTIVE', 'KZT', 'GRAM', 1, 1000000, 1, $2)
      `,
      [instrumentId, hash],
    );
    await pool.query(
      `
        INSERT INTO instrument_passport_versions (
          instrument_id, version, passport, review_state, passport_hash,
          submitted_at, published_at, created_by
        ) VALUES (
          $1, 1, $2::jsonb, 'APPROVED', $3, now(), now(), 'oms-test'
        )
      `,
      [
        instrumentId,
        JSON.stringify({
          tradingParameters: {
            tickSize: '10',
            lotSize: '10',
            minimumOrderQuantity: '10',
            minimumDeliveryQuantity: '10',
            settlementCycle: 'T_PLUS_1',
          },
        }),
        hash,
      ],
    );
    await pool.query(
      `
        INSERT INTO fee_schedules (
          instrument_id, version, currency, maker_rate_ppm, taker_rate_ppm, effective_from
        ) VALUES ($1, 1, 'KZT', 500, 1000, now() - interval '1 day')
      `,
      [instrumentId],
    );

    const buyerCashAvailable = (
      await ledger.openAccount({
        ownerId: buyerId,
        accountType: 'CASH',
        currency: 'KZT',
        purpose: 'AVAILABLE',
        normalSide: 'DEBIT',
      })
    ).id;
    const buyerCashReserved = (
      await ledger.openAccount({
        ownerId: buyerId,
        accountType: 'CASH',
        currency: 'KZT',
        purpose: 'RESERVED',
        normalSide: 'DEBIT',
      })
    ).id;
    const sellerTokenAvailable = (
      await ledger.openAccount({
        ownerId: sellerId,
        accountType: 'TOKEN',
        instrumentId,
        purpose: 'AVAILABLE',
        normalSide: 'DEBIT',
      })
    ).id;
    const sellerTokenReserved = (
      await ledger.openAccount({
        ownerId: sellerId,
        accountType: 'TOKEN',
        instrumentId,
        purpose: 'RESERVED',
        normalSide: 'DEBIT',
      })
    ).id;
    const clearingCashReserved = (
      await ledger.openAccount({
        ownerId: clearingId,
        accountType: 'CASH',
        currency: 'KZT',
        purpose: 'RESERVED',
        normalSide: 'DEBIT',
      })
    ).id;
    const clearingTokenReserved = (
      await ledger.openAccount({
        ownerId: clearingId,
        accountType: 'TOKEN',
        instrumentId,
        purpose: 'RESERVED',
        normalSide: 'DEBIT',
      })
    ).id;
    const cashIssuance = (
      await ledger.openAccount({
        ownerId: fundingId,
        accountType: 'CASH',
        currency: 'KZT',
        purpose: 'RESIDUAL',
        normalSide: 'CREDIT',
      })
    ).id;
    const tokenIssuance = (
      await ledger.openAccount({
        ownerId: fundingId,
        accountType: 'TOKEN',
        instrumentId,
        purpose: 'RESIDUAL',
        normalSide: 'CREDIT',
      })
    ).id;
    await ledger.post({
      idempotencyKey: `oms-test-cash-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: buyerCashAvailable, direction: 'DEBIT', amount: cash },
        { accountId: cashIssuance, direction: 'CREDIT', amount: cash },
      ],
    });
    await ledger.post({
      idempotencyKey: `oms-test-token-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: sellerTokenAvailable, direction: 'DEBIT', amount: tokens },
        { accountId: tokenIssuance, direction: 'CREDIT', amount: tokens },
      ],
    });
    await pool.query(
      `
        INSERT INTO oms_clearing_accounts (
          instrument_id, cash_reserved_account_id, token_reserved_account_id
        ) VALUES ($1, $2, $3)
      `,
      [instrumentId, clearingCashReserved, clearingTokenReserved],
    );
    return {
      instrumentId,
      buyerId,
      sellerId,
      buyerCashAvailable,
      buyerCashReserved,
      sellerTokenReserved,
      clearingCashReserved,
      clearingTokenReserved,
    };
  }

  function order(
    participantId: string,
    side: 'BUY' | 'SELL',
    price: bigint,
    quantity: bigint,
    clientOrderId: string,
  ): PlaceOrderCommand {
    return {
      participantId,
      clientOrderId,
      instrumentId: fixture.instrumentId,
      side,
      type: 'LIMIT',
      price,
      quantity,
      idempotencyKey: `oms-${clientOrderId}-${randomUUID()}`,
      correlationId: randomUUID(),
    };
  }

  function orderResult(result: OmsExecutionResult): OrderView {
    if ('code' in result.body) throw new Error(`${result.body.code}: ${result.body.message}`);
    return result.body;
  }

  function errorCode(result: OmsExecutionResult): string | undefined {
    return 'code' in result.body ? result.body.code : undefined;
  }

  async function count(table: string, predicate = 'true'): Promise<bigint> {
    const allowed = new Set([
      'trades',
      'settlements',
      'matching_events',
      'orders',
      'ledger_postings',
    ]);
    if (!allowed.has(table)) throw new Error(`Unsupported count table ${table}`);
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${predicate}`,
    );
    return BigInt(result.rows[0]?.count ?? '0');
  }

  async function accountBalance(accountId: LedgerAccountId): Promise<bigint> {
    return ledger.balanceOf(accountId);
  }

  async function reservedRemaining(orderId: string): Promise<bigint> {
    const result = await pool.query<{ amount: string }>(
      'SELECT reserved_remaining::text AS amount FROM orders WHERE id = $1',
      [orderId],
    );
    return BigInt(result.rows[0]?.amount ?? '0');
  }

  async function assertActiveReserveInvariant(
    participantId: string,
    side: 'BUY' | 'SELL',
  ): Promise<void> {
    const orders = await pool.query<{ reserve: string }>(
      `
        SELECT coalesce(sum(reserved_remaining), 0)::text AS reserve
        FROM orders
        WHERE party_id = $1 AND side = $2
          AND status IN ('OPEN', 'PARTIALLY_FILLED')
      `,
      [participantId, side],
    );
    const accounts = await pool.query<{ balance: string }>(
      `
        SELECT coalesce(sum(balance), 0)::text AS balance
        FROM ledger_accounts
        WHERE owner_party_id = $1 AND purpose = 'RESERVED'
          AND account_type = $2
      `,
      [participantId, side === 'BUY' ? 'CASH' : 'TOKEN'],
    );
    expect(accounts.rows[0]?.balance).toBe(orders.rows[0]?.reserve);
    expect(BigInt(accounts.rows[0]?.balance ?? '0')).toBeGreaterThanOrEqual(0n);
  }

  async function assertReplayMatchesBook(): Promise<void> {
    const book = await pool.query<{
      tick_size: string;
      lot_size: string;
      self_trade_policy: 'CANCEL_NEWEST';
    }>(
      `SELECT tick_size::text, lot_size::text, self_trade_policy
       FROM matching_books WHERE instrument_id = $1`,
      [fixture.instrumentId],
    );
    const events = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM matching_events WHERE instrument_id = $1 ORDER BY sequence',
      [fixture.instrumentId],
    );
    const row = book.rows[0];
    if (row === undefined) throw new Error('Matching book was not created');
    const config: EngineConfig = {
      instrumentId: fixture.instrumentId,
      tickSize: BigInt(row.tick_size),
      lotSize: BigInt(row.lot_size),
      selfTradePolicy: row.self_trade_policy,
      clock: () => '2026-08-14T12:00:00.000Z',
    };
    const replayed = new MatchingEngine(
      config,
      events.rows.map(({ payload }) => deserializeMatchingEvent(payload)),
    ).getOrderBook(20);
    const live = await service.orderBook(fixture.instrumentId, 20);
    expect({
      sequence: replayed.sequence.toString(),
      snapshotAt: replayed.snapshotAt,
      bids: replayed.bids.map((level) => ({
        price: level.price.toString(),
        quantity: level.quantity.toString(),
        orderCount: level.orderCount,
      })),
      asks: replayed.asks.map((level) => ({
        price: level.price.toString(),
        quantity: level.quantity.toString(),
        orderCount: level.orderCount,
      })),
    }).toEqual({
      sequence: live.sequence,
      snapshotAt: live.snapshotAt,
      bids: live.bids,
      asks: live.asks,
    });
  }
});

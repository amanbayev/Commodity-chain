import { createHash, randomUUID } from 'node:crypto';

import {
  InsufficientBalanceError,
  PostgresLedger,
  type LedgerAccountId,
} from '@commodity-chain/ledger';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { canonicalizeJson } from '../oracle-gateway/canonical-json.js';
import { RedemptionError } from './redemption.errors.js';
import { assertRedemptionTransition } from './redemption-state-machine.js';
import type {
  CancelRedemptionCommand,
  CreateRedemptionCommand,
  RedemptionErrorBody,
  RedemptionExecutionResult,
  RedemptionOracleAppliedEvent,
  RedemptionStatus,
  RedemptionView,
} from './redemption.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{1,128}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;

interface RedemptionRow extends QueryResultRow {
  id: string;
  holder_party_id: string;
  instrument_id: string;
  quantity: string;
  method: 'PHYSICAL_DELIVERY';
  status: RedemptionStatus;
  elevator_id: string;
  requested_date: Date | string;
  recipient: string;
  transport: string;
  proofs: readonly Readonly<Record<string, unknown>>[];
  idempotency_key: string;
  request_hash: Buffer;
  correlation_id: string;
  available_account_id: string;
  reserved_account_id: string;
  asset_id: string | null;
  oracle_event_id: string | null;
  delivery_deadline: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface InstrumentRow extends QueryResultRow {
  id: string;
  status: string;
  unit_per_token: string;
  circulating_supply: string;
  passport: Readonly<Record<string, unknown>>;
}

interface AccountPair {
  readonly available: LedgerAccountId;
  readonly reserved: LedgerAccountId;
}

export interface RedemptionServiceOptions {
  readonly deliveryTimeoutMs?: number;
  readonly now?: () => Date;
}

export class RedemptionService {
  private readonly deliveryTimeoutMs: number;
  private readonly now: () => Date;

  public constructor(
    private readonly pool: Pool,
    private readonly ledger: PostgresLedger,
    private readonly collateral: PostgresCollateralLedger,
    options: RedemptionServiceOptions = {},
  ) {
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 7 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  public async create(command: CreateRedemptionCommand): Promise<RedemptionExecutionResult> {
    const error = validateCreateCommand(command);
    if (error !== null) return failure(error, command.correlationId);
    const requestHash = hashRequest(command);
    try {
      return await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `redemption:${command.idempotencyKey}`,
        ]);
        const replay = await this.findByIdempotencyKey(client, command.idempotencyKey);
        if (replay !== null) {
          if (!replay.request_hash.equals(requestHash)) {
            return failure(
              new RedemptionError(
                'IDEMPOTENCY_KEY_REUSED',
                'Idempotency-Key was already used with a different request',
                409,
              ),
              command.correlationId,
            );
          }
          return { httpStatus: 202, replayed: true, body: mapView(replay) };
        }

        const instrument = await this.lockInstrument(client, command.instrumentId);
        if (!['ACTIVE', 'REDEMPTION'].includes(instrument.status)) {
          throw new RedemptionError(
            'REDEMPTION_NOT_ALLOWED',
            `Instrument status ${instrument.status} does not allow redemption`,
            409,
          );
        }
        const minimumDelivery = readMinimumDelivery(instrument.passport);
        if (command.quantity % minimumDelivery !== 0n) {
          throw new RedemptionError(
            'REDEMPTION_LOT_INVALID',
            `quantity must be a multiple of ${minimumDelivery.toString()} token minor units`,
            422,
            [{ field: 'quantity', reason: 'Quantity is not a physical-delivery lot multiple' }],
          );
        }
        await this.requireParty(client, command.holderId);
        const accounts = await this.loadAccounts(client, command.holderId, command.instrumentId);
        const id = randomUUID();
        const createdAt = this.now();
        const deadline = new Date(createdAt.getTime() + this.deliveryTimeoutMs);
        await client.query(
          `INSERT INTO redemption_orders (
             id, holder_party_id, instrument_id, quantity, method, status,
             elevator_id, requested_date, recipient, transport, proofs,
             idempotency_key, request_hash, correlation_id,
             available_account_id, reserved_account_id, delivery_deadline,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, 'PHYSICAL_DELIVERY', 'CREATED', $5, $6, $7, $8,
             $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $16
           )`,
          [
            id,
            command.holderId,
            command.instrumentId,
            command.quantity.toString(),
            command.delivery.elevatorId,
            command.delivery.requestedDate,
            command.delivery.recipient,
            command.delivery.transport,
            JSON.stringify(command.proofs),
            command.idempotencyKey,
            requestHash,
            command.correlationId,
            accounts.available,
            accounts.reserved,
            deadline,
            createdAt,
          ],
        );
        await this.recordTransition(
          client,
          id,
          null,
          'CREATED',
          `holder:${command.holderId}`,
          'Physical delivery requested',
          command.correlationId,
          false,
        );
        const reserve = await this.ledger.withinTransaction(client).reserve({
          idempotencyKey: `redemption:${id}:reserve`,
          correlationId: command.correlationId,
          availableAccountId: accounts.available,
          reservedAccountId: accounts.reserved,
          amount: command.quantity,
          metadata: { operation: 'REDEMPTION_RESERVE', redemptionId: id },
        });
        await client.query(
          `UPDATE redemption_orders
           SET status = 'TOKENS_LOCKED', reserve_posting_id = $2,
               locked_at = $3, updated_at = $3
           WHERE id = $1`,
          [id, reserve.id, createdAt],
        );
        await this.recordTransition(
          client,
          id,
          'CREATED',
          'TOKENS_LOCKED',
          'ledger:redemption',
          'Holder tokens reserved pending physical delivery',
          command.correlationId,
          true,
          {
            redemptionId: id,
            instrumentId: command.instrumentId,
            quantity: command.quantity.toString(),
          },
        );
        const row = await this.requireRedemption(client, id, false);
        return { httpStatus: 202, replayed: false, body: mapView(row) };
      });
    } catch (caught: unknown) {
      if (caught instanceof InsufficientBalanceError) {
        return failure(
          new RedemptionError(
            'INSUFFICIENT_FUNDS',
            'Holder has insufficient AVAILABLE token balance',
            422,
          ),
          command.correlationId,
        );
      }
      if (caught instanceof RedemptionError) return failure(caught, command.correlationId);
      throw caught;
    }
  }

  public async cancel(command: CancelRedemptionCommand): Promise<RedemptionExecutionResult> {
    try {
      assertUuid(command.redemptionId, 'redemptionId');
      assertUuid(command.holderId, 'holderId');
      assertUuid(command.correlationId, 'correlationId');
      return await this.transaction(async (client) => {
        const row = await this.requireRedemption(client, command.redemptionId, true);
        if (row.holder_party_id !== command.holderId) {
          throw new RedemptionError('RESOURCE_NOT_FOUND', 'Redemption was not found', 404);
        }
        if (row.status === 'CANCELLED') {
          return { httpStatus: 200, replayed: true, body: mapView(row) };
        }
        if (!['CREATED', 'TOKENS_LOCKED'].includes(row.status)) {
          throw new RedemptionError(
            'REDEMPTION_NOT_CANCELLABLE',
            `Redemption in ${row.status} cannot be cancelled`,
            409,
          );
        }
        if (row.status === 'TOKENS_LOCKED') {
          await this.ledger.withinTransaction(client).release({
            idempotencyKey: `redemption:${row.id}:cancel`,
            correlationId: command.correlationId,
            availableAccountId: row.available_account_id as LedgerAccountId,
            reservedAccountId: row.reserved_account_id as LedgerAccountId,
            amount: BigInt(row.quantity),
            metadata: { operation: 'REDEMPTION_CANCEL', redemptionId: row.id },
          });
        }
        assertRedemptionTransition(row.status, 'CANCELLED');
        await client.query(
          `UPDATE redemption_orders
           SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        await this.recordTransition(
          client,
          row.id,
          row.status,
          'CANCELLED',
          `holder:${command.holderId}`,
          'Cancelled before physical dispatch',
          command.correlationId,
          true,
        );
        return {
          httpStatus: 200,
          replayed: false,
          body: mapView(await this.requireRedemption(client, row.id, false)),
        };
      });
    } catch (caught: unknown) {
      if (caught instanceof RedemptionError) return failure(caught, command.correlationId);
      if (caught instanceof TypeError) {
        return failure(
          new RedemptionError('VALIDATION_ERROR', caught.message, 400),
          command.correlationId,
        );
      }
      throw caught;
    }
  }

  public async prepareDelivery(redemptionId: string, correlationId: string): Promise<string> {
    assertUuid(redemptionId, 'redemptionId');
    assertUuid(correlationId, 'correlationId');
    return this.transaction(async (client) => {
      const row = await this.requireRedemption(client, redemptionId, true);
      if (row.status === 'IN_DELIVERY' && row.asset_id !== null) return row.asset_id;
      assertRedemptionTransition(row.status, 'IN_DELIVERY');
      const instrument = await this.lockInstrument(client, row.instrument_id);
      const underlying = BigInt(row.quantity) * BigInt(instrument.unit_per_token);
      const receipt = await client.query<{ receipt_id: string } & QueryResultRow>(
        `SELECT receipt.receipt_id::text
         FROM mock_ezr_receipts AS receipt
         JOIN collateral_position AS position
           ON position.asset_id = receipt.receipt_id::text
          AND position.instrument_id = $1
         WHERE receipt.status = 'LOCKED'
           AND receipt.elevator_id = $2
           AND receipt.quantity = $3
           AND position.reserved >= $3
         ORDER BY receipt.created_at, receipt.receipt_id
         LIMIT 1
         FOR UPDATE OF receipt, position`,
        [row.instrument_id, row.elevator_id, underlying.toString()],
      );
      const assetId = receipt.rows[0]?.receipt_id;
      if (assetId === undefined) {
        throw new RedemptionError(
          'REDEMPTION_DELIVERY_EXCEPTION',
          'No exact locked receipt is available at the requested elevator',
          409,
        );
      }
      await client.query(
        `UPDATE redemption_orders
         SET status = 'IN_DELIVERY', asset_id = $2,
             delivery_started_at = now(), updated_at = now()
         WHERE id = $1`,
        [row.id, assetId],
      );
      await this.recordTransition(
        client,
        row.id,
        row.status,
        'IN_DELIVERY',
        'redemption-delivery-consumer',
        'Delivery handed to the configured EZR registry adapter',
        correlationId,
        true,
        { assetId },
      );
      return assetId;
    });
  }

  public async applyGoodsReleased(event: RedemptionOracleAppliedEvent): Promise<RedemptionView> {
    if (event.eventType !== 'GOODS_RELEASED' || event.redemptionId === undefined) {
      throw new RedemptionError(
        'VALIDATION_ERROR',
        'Expected GOODS_RELEASED with redemptionId',
        400,
      );
    }
    assertUuid(event.eventId, 'eventId');
    assertUuid(event.redemptionId, 'redemptionId');
    return this.transaction(async (client) => {
      const row = await this.requireRedemption(client, event.redemptionId!, true);
      if (row.status === 'COMPLETED') return mapView(row);
      if (row.status !== 'IN_DELIVERY') {
        throw new RedemptionError(
          'INVALID_TRANSITION',
          `GOODS_RELEASED cannot complete redemption in ${row.status}`,
          409,
        );
      }
      const oracle = await client.query<
        {
          id: string;
          event_id: string;
          status: string;
          event_type: string | null;
          quantity: string | null;
          redemption_id: string | null;
        } & QueryResultRow
      >(
        `SELECT id::text, event_id::text, status::text, event_type::text,
                quantity::text, redemption_id
         FROM oracle_events
         WHERE event_id = $1 AND instrument_id = $2 AND asset_id = $3
         FOR UPDATE`,
        [event.eventId, event.instrumentId, event.assetId],
      );
      const oracleRow = oracle.rows[0];
      if (
        oracleRow === undefined ||
        oracleRow.status !== 'APPLIED' ||
        oracleRow.event_type !== 'GOODS_RELEASED' ||
        oracleRow.quantity !== event.quantity ||
        oracleRow.redemption_id !== row.id ||
        row.instrument_id !== event.instrumentId ||
        row.asset_id !== event.assetId
      ) {
        throw new RedemptionError(
          'VALIDATION_ERROR',
          'Oracle provenance does not match the redemption',
          422,
        );
      }
      const instrument = await this.lockInstrument(client, row.instrument_id);
      const tokenQuantity = BigInt(row.quantity);
      const expectedUnderlying = tokenQuantity * BigInt(instrument.unit_per_token);
      const observed = parsePositive(oracleRow.quantity, 'quantity');
      if (observed !== expectedUnderlying) {
        await this.quarantine(
          client,
          row,
          event,
          expectedUnderlying,
          observed,
          BigInt(oracleRow.id),
        );
        return mapView(await this.requireRedemption(client, row.id, false));
      }
      const distribution = await client.query<{ id: string } & QueryResultRow>(
        `SELECT mapping.distribution_account_id::text AS id
         FROM instrument_token_accounts AS mapping
         JOIN ledger_accounts AS account ON account.id = mapping.distribution_account_id
         WHERE mapping.instrument_id = $1
         FOR UPDATE OF account`,
        [row.instrument_id],
      );
      const distributionId = distribution.rows[0]?.id;
      if (distributionId === undefined) {
        throw new RedemptionError(
          'REDEMPTION_DELIVERY_EXCEPTION',
          'Instrument distribution account is not configured',
          409,
        );
      }
      const burn = await this.ledger.withinTransaction(client).post({
        idempotencyKey: `redemption:${row.id}:burn`,
        correlationId: event.correlationId,
        legs: [
          {
            accountId: row.reserved_account_id as LedgerAccountId,
            direction: 'CREDIT',
            amount: tokenQuantity,
          },
          {
            accountId: distributionId as LedgerAccountId,
            direction: 'DEBIT',
            amount: tokenQuantity,
          },
        ],
        metadata: {
          operation: 'REDEMPTION_BURN',
          redemptionId: row.id,
          oracleEventId: event.eventId,
        },
      });
      if (BigInt(instrument.circulating_supply) < tokenQuantity) {
        throw new RedemptionError(
          'REDEMPTION_DELIVERY_EXCEPTION',
          'Circulating supply is lower than redemption quantity',
          409,
        );
      }
      await client.query(
        `UPDATE instrument
         SET circulating_supply = circulating_supply - $2, updated_at = now()
         WHERE id = $1`,
        [row.instrument_id, tokenQuantity.toString()],
      );
      await this.collateral.releaseWithinTransaction(
        client,
        event.assetId,
        event.instrumentId,
        expectedUnderlying,
        event.eventId,
      );
      assertRedemptionTransition(row.status, 'COMPLETED');
      await client.query(
        `UPDATE redemption_orders
         SET status = 'COMPLETED', burn_posting_id = $2,
             oracle_event_row_id = $3, oracle_event_id = $4,
             completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [row.id, burn.id, oracleRow.id, event.eventId],
      );
      await this.recordTransition(
        client,
        row.id,
        row.status,
        'COMPLETED',
        'oracle:goods-released',
        'Applied evidenced physical delivery and atomically burned reserved tokens',
        event.correlationId,
        true,
        {
          oracleEventId: event.eventId,
          assetId: event.assetId,
          tokenQuantity: tokenQuantity.toString(),
          collateralQuantity: expectedUnderlying.toString(),
          burnPostingId: burn.id,
        },
      );
      return mapView(await this.requireRedemption(client, row.id, false));
    });
  }

  public async expireOverdue(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    return this.transaction(async (client) => {
      const result = await client.query<RedemptionRow>(
        `${SELECT_REDEMPTION}
         WHERE status IN ('TOKENS_LOCKED', 'IN_DELIVERY')
           AND delivery_deadline <= $1
         ORDER BY delivery_deadline, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [this.now(), limit],
      );
      for (const row of result.rows) {
        assertRedemptionTransition(row.status, 'EXCEPTION');
        await client.query(
          `UPDATE redemption_orders
           SET status = 'EXCEPTION', failure_code = 'DELIVERY_TIMEOUT',
               failure_details = jsonb_build_object('tokensRemainReserved', true),
               exception_at = now(), updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        await this.recordTransition(
          client,
          row.id,
          row.status,
          'EXCEPTION',
          'redemption-timeout-job',
          'No GOODS_RELEASED event received before the delivery deadline; tokens remain reserved',
          row.correlation_id,
          false,
        );
        await this.appendIncident(client, row.id, row.correlation_id, {
          code: 'REDEMPTION_DELIVERY_TIMEOUT',
          tokensRemainReserved: true,
        });
      }
      return result.rows.length;
    });
  }

  private async quarantine(
    client: PoolClient,
    row: RedemptionRow,
    event: RedemptionOracleAppliedEvent,
    expected: bigint,
    observed: bigint,
    oracleRowId: bigint,
  ): Promise<void> {
    assertRedemptionTransition(row.status, 'QUARANTINED');
    await client.query(
      `UPDATE redemption_orders
       SET status = 'QUARANTINED', oracle_event_row_id = $2, oracle_event_id = $3,
           failure_code = 'REDEMPTION_QUANTITY_MISMATCH',
           failure_details = $4::jsonb, quarantined_at = now(), updated_at = now()
       WHERE id = $1`,
      [
        row.id,
        oracleRowId.toString(),
        event.eventId,
        JSON.stringify({ expected: expected.toString(), observed: observed.toString() }),
      ],
    );
    await this.recordTransition(
      client,
      row.id,
      row.status,
      'QUARANTINED',
      'oracle:goods-released',
      'Released quantity does not match the redemption obligation; no burn was applied',
      event.correlationId,
      true,
    );
    await this.appendIncident(client, row.id, event.correlationId, {
      code: 'REDEMPTION_QUANTITY_MISMATCH',
      expected: expected.toString(),
      observed: observed.toString(),
      oracleEventId: event.eventId,
    });
  }

  private async recordTransition(
    client: PoolClient,
    redemptionId: string,
    from: RedemptionStatus | null,
    to: RedemptionStatus,
    actor: string,
    reason: string,
    correlationId: string,
    publish: boolean,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO redemption_transitions (
         redemption_id, from_status, to_status, actor, reason, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [redemptionId, from, to, actor, reason, correlationId],
    );
    const payload = {
      eventId: randomUUID(),
      schemaVersion: '1',
      redemptionId,
      fromStatus: from,
      status: to,
      reason,
      correlationId,
      ...extra,
    };
    await client.query(
      `INSERT INTO event_log (
         actor, event_type, aggregate_type, aggregate_id, correlation_id, payload
       ) VALUES ($1, $2, 'REDEMPTION', $3, $4, $5::jsonb)`,
      [actor, `REDEMPTION_${to}`, redemptionId, correlationId, JSON.stringify(payload)],
    );
    if (publish) {
      await client.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)', [
        `domain.redemption.${to.toLowerCase().replace('_', '-')}.v1`,
        JSON.stringify(payload),
      ]);
    }
  }

  private async appendIncident(
    client: PoolClient,
    redemptionId: string,
    correlationId: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO event_log (
         actor, event_type, aggregate_type, aggregate_id, correlation_id, payload
       ) VALUES ('redemption-monitor', 'INCIDENT', 'REDEMPTION', $1, $2, $3::jsonb)`,
      [redemptionId, correlationId, JSON.stringify({ redemptionId, ...details })],
    );
  }

  private async lockInstrument(client: PoolClient, instrumentId: string): Promise<InstrumentRow> {
    const result = await client.query<InstrumentRow>(
      `SELECT instrument.id::text, instrument.status::text,
              instrument.unit_per_token::text, instrument.circulating_supply::text,
              version.passport
       FROM instrument
       JOIN instrument_passport_versions AS version
         ON version.instrument_id = instrument.id AND version.version = instrument.version
       WHERE instrument.id = $1
       FOR UPDATE OF instrument`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RedemptionError('RESOURCE_NOT_FOUND', 'Instrument was not found', 404);
    }
    return row;
  }

  private async requireParty(client: PoolClient, partyId: string): Promise<void> {
    const result = await client.query('SELECT 1 FROM party WHERE id = $1', [partyId]);
    if (result.rowCount !== 1) {
      throw new RedemptionError('RESOURCE_NOT_FOUND', 'Holder was not found', 404);
    }
  }

  private async loadAccounts(
    client: PoolClient,
    holderId: string,
    instrumentId: string,
  ): Promise<AccountPair> {
    const result = await client.query<
      { id: string; purpose: 'AVAILABLE' | 'RESERVED' } & QueryResultRow
    >(
      `SELECT id::text, purpose::text
       FROM ledger_accounts
       WHERE owner_party_id = $1 AND account_type = 'TOKEN' AND instrument_id = $2
         AND purpose IN ('AVAILABLE', 'RESERVED')
       ORDER BY purpose
       FOR UPDATE`,
      [holderId, instrumentId],
    );
    const available = result.rows.find((row) => row.purpose === 'AVAILABLE')?.id;
    const reserved = result.rows.find((row) => row.purpose === 'RESERVED')?.id;
    if (available === undefined || reserved === undefined) {
      throw new RedemptionError(
        'REDEMPTION_NOT_ALLOWED',
        'Holder AVAILABLE and RESERVED token accounts are required',
        409,
      );
    }
    return { available: available as LedgerAccountId, reserved: reserved as LedgerAccountId };
  }

  private async findByIdempotencyKey(
    client: PoolClient,
    key: string,
  ): Promise<RedemptionRow | null> {
    const result = await client.query<RedemptionRow>(
      `${SELECT_REDEMPTION} WHERE idempotency_key = $1`,
      [key],
    );
    return result.rows[0] ?? null;
  }

  private async requireRedemption(
    client: PoolClient,
    id: string,
    lock: boolean,
  ): Promise<RedemptionRow> {
    const result = await client.query<RedemptionRow>(
      `${SELECT_REDEMPTION} WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RedemptionError('RESOURCE_NOT_FOUND', 'Redemption was not found', 404);
    }
    return row;
  }

  private async transaction<Result>(
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
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

const SELECT_REDEMPTION = `
  SELECT id::text, holder_party_id::text, instrument_id::text, quantity::text,
         method, status::text, elevator_id, requested_date, recipient, transport,
         proofs, idempotency_key, request_hash, correlation_id::text,
         available_account_id::text, reserved_account_id::text, asset_id,
         oracle_event_id::text, delivery_deadline, created_at, updated_at, completed_at
  FROM redemption_orders
`;

export function validateCreateCommand(command: CreateRedemptionCommand): RedemptionError | null {
  try {
    assertUuid(command.holderId, 'holderId');
    assertUuid(command.instrumentId, 'instrumentId');
    assertUuid(command.correlationId, 'correlationId');
    if (!IDEMPOTENCY.test(command.idempotencyKey)) throw new TypeError('idempotencyKey is invalid');
    if (
      typeof command.quantity !== 'bigint' ||
      command.quantity <= 0n ||
      command.quantity > MAX_NUMERIC_38
    ) {
      throw new TypeError('quantity must be a positive bigint within NUMERIC(38,0)');
    }
    if (command.method !== 'PHYSICAL_DELIVERY') {
      throw new TypeError('Only PHYSICAL_DELIVERY is available');
    }
    if (
      !IDEMPOTENCY.test(command.delivery.elevatorId) ||
      !DATE.test(command.delivery.requestedDate) ||
      command.delivery.recipient.trim() === '' ||
      command.delivery.transport.trim() === '' ||
      !Array.isArray(command.proofs)
    ) {
      throw new TypeError('delivery details are invalid');
    }
    return null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid redemption request';
    return new RedemptionError('VALIDATION_ERROR', message, 400);
  }
}

function readMinimumDelivery(passport: Readonly<Record<string, unknown>>): bigint {
  const trading = passport['tradingParameters'];
  const value =
    trading !== null && typeof trading === 'object' && !Array.isArray(trading)
      ? (trading as Record<string, unknown>)['minimumDeliveryQuantity']
      : undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new RedemptionError(
      'REDEMPTION_NOT_ALLOWED',
      'Instrument passport has no valid minimumDeliveryQuantity',
      409,
    );
  }
  return BigInt(value);
}

function hashRequest(command: CreateRedemptionCommand): Buffer {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        holderId: command.holderId,
        instrumentId: command.instrumentId,
        quantity: command.quantity.toString(),
        method: command.method,
        delivery: command.delivery,
        proofs: command.proofs,
      }),
    )
    .digest();
}

function mapView(row: RedemptionRow): RedemptionView {
  return {
    id: row.id,
    holder: row.holder_party_id,
    instrumentId: row.instrument_id,
    quantity: row.quantity,
    method: row.method,
    status: row.status,
    delivery: {
      elevatorId: row.elevator_id,
      requestedDate:
        row.requested_date instanceof Date
          ? row.requested_date.toISOString().slice(0, 10)
          : String(row.requested_date).slice(0, 10),
      recipient: row.recipient,
      transport: row.transport,
    },
    proofs: row.proofs,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deliveryDeadline: iso(row.delivery_deadline),
    ...(row.completed_at === null ? {} : { completedAt: iso(row.completed_at) }),
  };
}

function failure(error: RedemptionError, correlationId: string): RedemptionExecutionResult {
  const body: RedemptionErrorBody = {
    code: error.code,
    message: error.message,
    correlationId,
    details: error.details,
  };
  return { httpStatus: error.httpStatus, replayed: false, body };
}

function parsePositive(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new RedemptionError(
      'VALIDATION_ERROR',
      `${field} must be a positive integer string`,
      400,
    );
  }
  return BigInt(value);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new TypeError(`${field} must be a UUID`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

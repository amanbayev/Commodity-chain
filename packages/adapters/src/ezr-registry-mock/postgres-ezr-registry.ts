import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  EzrRegistry,
  OracleEventEnvelope,
  OracleEventPublisher,
  OracleEventType,
  Receipt,
  ReceiptStatus,
  UnsignedOracleEventEnvelope,
} from '../ezr-registry/types.js';
import { EzrRegistryError } from '../ezr-registry/types.js';
import { canonicalJson } from './canonical-json.js';
import { signOracleEvent } from './signing.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;
const MAX_SAFE_NONCE = BigInt(Number.MAX_SAFE_INTEGER);

interface ReceiptRow extends QueryResultRow {
  receipt_id: string;
  owner: string;
  commodity: string;
  quantity: string;
  unit: string;
  elevator_id: string;
  status: ReceiptStatus;
  instrument_id: string;
  redemption_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OutboxRow extends QueryResultRow {
  event_id: string;
  envelope: OracleEventEnvelope;
  correlation_id: string;
  idempotency_key: string;
}

export interface IssueReceiptContext {
  readonly owner: string;
  readonly commodity: string;
  readonly quantity: bigint;
  readonly elevatorId: string;
}

export interface PostgresEzrRegistryOptions {
  readonly pool: Pool;
  readonly sourceId: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly oraclePublisher: OracleEventPublisher;
  readonly instrumentIdForReceipt: (input: IssueReceiptContext) => string | Promise<string>;
  readonly unitForCommodity: (commodity: string) => string;
  readonly now?: () => Date;
}

export class PostgresEzrRegistry implements EzrRegistry {
  private readonly now: () => Date;

  public constructor(private readonly options: PostgresEzrRegistryOptions) {
    assertExternalId(options.sourceId, 'sourceId');
    assertExternalId(options.keyId, 'keyId');
    this.now = options.now ?? (() => new Date());
  }

  public async issueReceipt(
    owner: string,
    commodity: string,
    quantity: bigint,
    elevatorId: string,
  ): Promise<Receipt> {
    assertExternalId(owner, 'owner');
    assertCode(commodity, 'commodity');
    assertQuantity(quantity);
    assertExternalId(elevatorId, 'elevatorId');

    const context = { owner, commodity, quantity, elevatorId };
    const instrumentId = await this.options.instrumentIdForReceipt(context);
    assertUuid(instrumentId, 'instrumentIdForReceipt result');
    const unit = this.options.unitForCommodity(commodity);
    assertCode(unit, 'unitForCommodity result');

    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const receiptId = randomUUID();
      const changedAt = this.now();
      const result = await client.query<ReceiptRow>(
        `
          INSERT INTO mock_ezr_receipts (
            receipt_id, owner, commodity, quantity, unit, elevator_id,
            status, instrument_id, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'AVAILABLE', $7, $8, $8)
          RETURNING *, quantity::text
        `,
        [
          receiptId,
          owner,
          commodity,
          quantity.toString(),
          unit,
          elevatorId,
          instrumentId,
          changedAt,
        ],
      );
      const receipt = mapReceipt(requireRow(result.rows[0]));
      await this.enqueueEvent(client, receipt, 'STOCK_UPDATED', changedAt);
      await client.query('COMMIT');
      await this.drainOutbox();
      return receipt;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async lockReceipt(receiptId: string, instrumentId: string): Promise<Receipt> {
    assertUuid(receiptId, 'receiptId');
    assertUuid(instrumentId, 'instrumentId');

    return this.changeReceipt(receiptId, async (client, current) => {
      if (current.status === 'LOCKED') {
        throw new EzrRegistryError(
          'ALREADY_ENCUMBERED',
          `Receipt ${receiptId} is already encumbered`,
        );
      }
      if (current.status !== 'AVAILABLE') {
        throw new EzrRegistryError('INVALID_STATE', `Receipt ${receiptId} cannot be locked`);
      }
      if (current.instrumentId !== instrumentId) {
        throw new EzrRegistryError(
          'INSTRUMENT_MISMATCH',
          `Receipt ${receiptId} belongs to another instrument`,
        );
      }

      return this.updateReceipt(client, current, 'LOCKED', null, 'RECEIPT_LOCKED');
    });
  }

  public async releaseReceipt(receiptId: string, redemptionId: string): Promise<Receipt> {
    assertUuid(receiptId, 'receiptId');
    assertExternalId(redemptionId, 'redemptionId');

    return this.changeReceipt(receiptId, async (client, current) => {
      if (current.status === 'RELEASED' && current.redemptionId === redemptionId) {
        return current;
      }
      if (current.status !== 'LOCKED') {
        throw new EzrRegistryError('INVALID_STATE', `Receipt ${receiptId} cannot be released`);
      }

      return this.updateReceipt(client, current, 'RELEASED', redemptionId, 'GOODS_RELEASED');
    });
  }

  public async getReceipt(receiptId: string): Promise<Receipt | null> {
    assertUuid(receiptId, 'receiptId');
    const result = await this.options.pool.query<ReceiptRow>(
      'SELECT *, quantity::text FROM mock_ezr_receipts WHERE receipt_id = $1',
      [receiptId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapReceipt(row);
  }

  public async drainOutbox(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new EzrRegistryError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 1000');
    }
    const result = await this.options.pool.query<{ event_id: string } & QueryResultRow>(
      `
        SELECT event_id
        FROM mock_ezr_http_outbox
        WHERE delivered_at IS NULL
        ORDER BY created_at, event_id
        LIMIT $1
      `,
      [limit],
    );

    let delivered = 0;
    for (const row of result.rows) {
      if (!(await this.attemptDelivery(row.event_id))) {
        break;
      }
      delivered += 1;
    }
    return delivered;
  }

  private async changeReceipt(
    receiptId: string,
    change: (client: PoolClient, current: Receipt) => Promise<Receipt>,
  ): Promise<Receipt> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ReceiptRow>(
        `
          SELECT *, quantity::text
          FROM mock_ezr_receipts
          WHERE receipt_id = $1
          FOR UPDATE
        `,
        [receiptId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new EzrRegistryError('RECEIPT_NOT_FOUND', `Receipt ${receiptId} was not found`);
      }

      const changed = await change(client, mapReceipt(row));
      await client.query('COMMIT');
      await this.drainOutbox();
      return changed;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateReceipt(
    client: PoolClient,
    current: Receipt,
    status: ReceiptStatus,
    redemptionId: string | null,
    eventType: OracleEventType,
  ): Promise<Receipt> {
    const changedAt = this.now();
    const result = await client.query<ReceiptRow>(
      `
        UPDATE mock_ezr_receipts
        SET status = $2, redemption_id = $3, updated_at = $4
        WHERE receipt_id = $1
        RETURNING *, quantity::text
      `,
      [current.receiptId, status, redemptionId, changedAt],
    );
    const receipt = mapReceipt(requireRow(result.rows[0]));
    await this.enqueueEvent(client, receipt, eventType, changedAt);
    return receipt;
  }

  private async enqueueEvent(
    client: PoolClient,
    receipt: Receipt,
    eventType: OracleEventType,
    changedAt: Date,
  ): Promise<string> {
    const nonceResult = await client.query<{ last_nonce: string } & QueryResultRow>(
      `
        INSERT INTO mock_ezr_source_counters (source_id, last_nonce)
        VALUES ($1, 1)
        ON CONFLICT (source_id) DO UPDATE
        SET last_nonce = mock_ezr_source_counters.last_nonce + 1,
            updated_at = now()
        WHERE mock_ezr_source_counters.last_nonce < $2
        RETURNING last_nonce::text
      `,
      [this.options.sourceId, MAX_SAFE_NONCE.toString()],
    );
    const nonceRow = nonceResult.rows[0];
    if (nonceRow === undefined) {
      throw new EzrRegistryError('INVALID_STATE', 'Source nonce exceeded JSON safe integer range');
    }

    const nonce = Number(BigInt(nonceRow.last_nonce));
    const eventId = randomUUID();
    const correlationId = randomUUID();
    const unsigned: UnsignedOracleEventEnvelope = {
      eventId,
      schemaVersion: '1',
      instrumentId: receipt.instrumentId,
      assetId: receipt.receiptId,
      eventType,
      quantity: receipt.quantity.toString(),
      unit: receipt.unit,
      observedAt: changedAt.toISOString(),
      effectiveAt: changedAt.toISOString(),
      sourceId: this.options.sourceId,
      ...(receipt.redemptionId === undefined ? {} : { redemptionId: receipt.redemptionId }),
      evidenceHash: evidenceHash(receipt, eventType),
      nonce,
    };
    const envelope = signOracleEvent(unsigned, this.options.keyId, this.options.privateKeyPem);

    await client.query(
      `
        INSERT INTO mock_ezr_http_outbox (
          event_id, source_id, receipt_id, envelope, correlation_id, idempotency_key
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      `,
      [
        eventId,
        this.options.sourceId,
        receipt.receiptId,
        JSON.stringify(envelope),
        correlationId,
        eventId,
      ],
    );
    return eventId;
  }

  private async attemptDelivery(eventId: string): Promise<boolean> {
    const result = await this.options.pool.query<OutboxRow>(
      `
        SELECT event_id, envelope, correlation_id, idempotency_key
        FROM mock_ezr_http_outbox
        WHERE event_id = $1 AND delivered_at IS NULL
      `,
      [eventId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return true;
    }

    try {
      const receipt = await this.options.oraclePublisher.publish(row.envelope, {
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      });
      await this.options.pool.query(
        `
          UPDATE mock_ezr_http_outbox
          SET attempts = attempts + 1,
              last_attempted_at = now(),
              delivered_at = now(),
              http_status = 202,
              response_body = $2::jsonb,
              last_error = NULL
          WHERE event_id = $1 AND delivered_at IS NULL
        `,
        [eventId, JSON.stringify(receipt)],
      );
      return true;
    } catch (error: unknown) {
      await this.options.pool.query(
        `
          UPDATE mock_ezr_http_outbox
          SET attempts = attempts + 1,
              last_attempted_at = now(),
              last_error = $2
          WHERE event_id = $1 AND delivered_at IS NULL
        `,
        [eventId, error instanceof Error ? error.message : 'Unknown delivery error'],
      );
      return false;
    }
  }
}

function mapReceipt(row: ReceiptRow): Receipt {
  return {
    receiptId: row.receipt_id,
    owner: row.owner,
    commodity: row.commodity,
    quantity: BigInt(row.quantity),
    unit: row.unit,
    elevatorId: row.elevator_id,
    status: row.status,
    instrumentId: row.instrument_id,
    ...(row.redemption_id === null ? {} : { redemptionId: row.redemption_id }),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function requireRow(row: ReceiptRow | undefined): ReceiptRow {
  if (row === undefined) {
    throw new EzrRegistryError('INVALID_STATE', 'PostgreSQL did not return the changed receipt');
  }
  return row;
}

function assertQuantity(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_NUMERIC_38) {
    throw new EzrRegistryError(
      'INVALID_ARGUMENT',
      'quantity must be a positive bigint within NUMERIC(38,0)',
    );
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EzrRegistryError('INVALID_ARGUMENT', `${field} must be a UUID`);
  }
}

function assertExternalId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !EXTERNAL_ID_PATTERN.test(value)) {
    throw new EzrRegistryError('INVALID_ARGUMENT', `${field} must be a valid external identifier`);
  }
}

function assertCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 32 || !CODE_PATTERN.test(value)) {
    throw new EzrRegistryError('INVALID_ARGUMENT', `${field} must be an uppercase code`);
  }
}

function evidenceHash(receipt: Receipt, eventType: OracleEventType): string {
  const evidence = canonicalJson({
    commodity: receipt.commodity,
    elevatorId: receipt.elevatorId,
    eventType,
    instrumentId: receipt.instrumentId,
    owner: receipt.owner,
    quantity: receipt.quantity.toString(),
    receiptId: receipt.receiptId,
    ...(receipt.redemptionId === undefined ? {} : { redemptionId: receipt.redemptionId }),
    status: receipt.status,
    unit: receipt.unit,
  });
  return `sha256:${createHash('sha256').update(evidence).digest('hex')}`;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  AcceptOracleEventResult,
  OracleErrorCode,
  OracleEventEnvelope,
  OracleProcessingStatus,
} from './oracle-event.types.js';

export interface TrustedSourceKey {
  readonly sourceId: string;
  readonly keyId: string;
  readonly algorithm: string;
  readonly publicKeyPem: string;
  readonly revokedAt: string | null;
}

export interface StoredOracleEvent {
  readonly id: string;
  readonly sourceId: string | null;
  readonly eventId: string | null;
  readonly status: OracleProcessingStatus;
  readonly requestHash: Buffer;
  readonly createdAt: string;
  readonly httpStatus: AcceptOracleEventResult['httpStatus'] | null;
  readonly responseBody: AcceptOracleEventResult['body'] | null;
}

export interface InsertReceivedInput {
  readonly sourceId: string | null;
  readonly eventId: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly requestHash: Buffer;
  readonly rawPayload: unknown;
}

export interface CompleteOracleEventInput {
  readonly id: string;
  readonly from: OracleProcessingStatus;
  readonly to: OracleProcessingStatus;
  readonly result: AcceptOracleEventResult;
  readonly failureCode?: OracleErrorCode;
  readonly failureDetails?: unknown;
}

export interface ApplyOracleEventInput {
  readonly stored: StoredOracleEvent;
  readonly envelope: OracleEventEnvelope;
  readonly correlationId: string;
  readonly result: AcceptOracleEventResult;
}

export interface OracleEventTransaction {
  lockIdempotencyKey(idempotencyKey: string): Promise<void>;
  lockSource(sourceId: string): Promise<void>;
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredOracleEvent | null>;
  findBySourceEvent(sourceId: string, eventId: string): Promise<StoredOracleEvent | null>;
  findAppliedByNonce(sourceId: string, nonce: bigint): Promise<StoredOracleEvent | null>;
  lastAppliedNonce(sourceId: string): Promise<bigint>;
  findTrustedKey(sourceId: string, keyId: string): Promise<TrustedSourceKey | null>;
  insertReceived(input: InsertReceivedInput): Promise<StoredOracleEvent>;
  hydrateValidated(id: string, envelope: OracleEventEnvelope): Promise<void>;
  transition(id: string, from: OracleProcessingStatus, to: OracleProcessingStatus): Promise<void>;
  complete(input: CompleteOracleEventInput): Promise<void>;
  apply(input: ApplyOracleEventInput): Promise<void>;
}

export interface OracleEventRepository {
  withTransaction<Result>(
    operation: (transaction: OracleEventTransaction) => Promise<Result>,
  ): Promise<Result>;
}

interface OracleEventRow extends QueryResultRow {
  id: string;
  source_id: string | null;
  event_id: string | null;
  status: OracleProcessingStatus;
  request_hash: Buffer;
  created_at: Date | string;
  http_status: number | null;
  response_body: AcceptOracleEventResult['body'] | null;
}

interface TrustedSourceRow extends QueryResultRow {
  source_id: string;
  key_id: string;
  algorithm: string;
  public_key_pem: string;
  revoked_at: Date | string | null;
}

const ORACLE_EVENT_SELECT = `
  SELECT
    id::text,
    source_id,
    event_id::text,
    status,
    request_hash,
    created_at,
    http_status,
    response_body
  FROM oracle_events
`;

export class PostgresOracleEventRepository implements OracleEventRepository {
  public constructor(private readonly pool: Pool) {}

  public async withTransaction<Result>(
    operation: (transaction: OracleEventTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(new PostgresOracleEventTransaction(client));
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

class PostgresOracleEventTransaction implements OracleEventTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async lockIdempotencyKey(idempotencyKey: string): Promise<void> {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `oracle-idempotency:${idempotencyKey}`,
    ]);
  }

  public async lockSource(sourceId: string): Promise<void> {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `oracle-source:${sourceId}`,
    ]);
  }

  public async findByIdempotencyKey(idempotencyKey: string): Promise<StoredOracleEvent | null> {
    return this.findOne(`${ORACLE_EVENT_SELECT} WHERE idempotency_key = $1`, [idempotencyKey]);
  }

  public async findBySourceEvent(
    sourceId: string,
    eventId: string,
  ): Promise<StoredOracleEvent | null> {
    return this.findOne(`${ORACLE_EVENT_SELECT} WHERE source_id = $1 AND event_id = $2`, [
      sourceId,
      eventId,
    ]);
  }

  public async findAppliedByNonce(
    sourceId: string,
    nonce: bigint,
  ): Promise<StoredOracleEvent | null> {
    return this.findOne(
      `${ORACLE_EVENT_SELECT} WHERE source_id = $1 AND nonce = $2 AND status = 'APPLIED'`,
      [sourceId, nonce.toString()],
    );
  }

  public async lastAppliedNonce(sourceId: string): Promise<bigint> {
    const result = await this.client.query<{ nonce: string } & QueryResultRow>(
      `
        SELECT coalesce(max(nonce), 0)::text AS nonce
        FROM oracle_events
        WHERE source_id = $1 AND status = 'APPLIED'
      `,
      [sourceId],
    );
    return BigInt(result.rows[0]?.nonce ?? '0');
  }

  public async findTrustedKey(sourceId: string, keyId: string): Promise<TrustedSourceKey | null> {
    const result = await this.client.query<TrustedSourceRow>(
      `
        SELECT source_id, key_id, algorithm, public_key_pem, revoked_at
        FROM trusted_sources
        WHERE source_id = $1 AND key_id = $2
      `,
      [sourceId, keyId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          sourceId: row.source_id,
          keyId: row.key_id,
          algorithm: row.algorithm,
          publicKeyPem: row.public_key_pem,
          revokedAt: row.revoked_at === null ? null : toIsoString(row.revoked_at),
        };
  }

  public async insertReceived(input: InsertReceivedInput): Promise<StoredOracleEvent> {
    const result = await this.client.query<OracleEventRow>(
      `
        INSERT INTO oracle_events (
          source_id,
          event_id,
          status,
          correlation_id,
          idempotency_key,
          request_hash,
          raw_payload
        )
        VALUES ($1, $2, 'RECEIVED', $3, $4, $5, $6::jsonb)
        RETURNING
          id::text,
          source_id,
          event_id::text,
          status,
          request_hash,
          created_at,
          http_status,
          response_body
      `,
      [
        input.sourceId,
        input.eventId,
        input.correlationId,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify(input.rawPayload),
      ],
    );
    return mapStoredEvent(requireRow(result.rows[0]));
  }

  public async hydrateValidated(id: string, envelope: OracleEventEnvelope): Promise<void> {
    await this.client.query(
      `
        UPDATE oracle_events
        SET
          source_id = $2,
          event_id = $3,
          schema_version = $4,
          instrument_id = $5,
          asset_id = $6,
          event_type = $7,
          quantity = $8,
          unit = $9,
          observed_at = $10,
          effective_at = $11,
          evidence_hash = $12,
          nonce = $13,
          signature = $14::jsonb,
          extensions = $15::jsonb
        WHERE id = $1
      `,
      [
        id,
        envelope.sourceId,
        envelope.eventId,
        envelope.schemaVersion,
        envelope.instrumentId,
        envelope.assetId,
        envelope.eventType,
        envelope.quantity,
        envelope.unit,
        envelope.observedAt,
        envelope.effectiveAt,
        envelope.evidenceHash,
        envelope.nonce.toString(),
        JSON.stringify(envelope.signature),
        JSON.stringify(envelope.extensions ?? {}),
      ],
    );
  }

  public async transition(
    id: string,
    from: OracleProcessingStatus,
    to: OracleProcessingStatus,
  ): Promise<void> {
    const result = await this.client.query(
      `
        UPDATE oracle_events
        SET status = $3, status_updated_at = now()
        WHERE id = $1 AND status = $2
      `,
      [id, from, to],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Invalid oracle event transition ${from} -> ${to} for ${id}`);
    }
  }

  public async complete(input: CompleteOracleEventInput): Promise<void> {
    const result = await this.client.query(
      `
        UPDATE oracle_events
        SET
          status = $3,
          status_updated_at = now(),
          http_status = $4,
          response_body = $5::jsonb,
          failure_code = $6,
          failure_details = $7::jsonb
        WHERE id = $1 AND status = $2
      `,
      [
        input.id,
        input.from,
        input.to,
        input.result.httpStatus,
        JSON.stringify(input.result.body),
        input.failureCode ?? null,
        input.failureDetails === undefined ? null : JSON.stringify(input.failureDetails),
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Invalid oracle event completion ${input.from} -> ${input.to}`);
    }
  }

  public async apply(input: ApplyOracleEventInput): Promise<void> {
    const { stored, envelope, correlationId, result } = input;
    const update = await this.client.query(
      `
        UPDATE oracle_events
        SET
          status = 'APPLIED',
          status_updated_at = now(),
          applied_at = now(),
          http_status = $3,
          response_body = $4::jsonb
        WHERE id = $1 AND status = $2
      `,
      [stored.id, 'POLICY_VALIDATED', result.httpStatus, JSON.stringify(result.body)],
    );
    if (update.rowCount !== 1) {
      throw new Error(`Oracle event ${stored.id} was not policy validated`);
    }

    const domainPayload = {
      eventId: envelope.eventId,
      schemaVersion: envelope.schemaVersion,
      sourceId: envelope.sourceId,
      instrumentId: envelope.instrumentId,
      assetId: envelope.assetId,
      eventType: envelope.eventType,
      quantity: envelope.quantity,
      unit: envelope.unit,
      observedAt: envelope.observedAt,
      effectiveAt: envelope.effectiveAt,
      evidenceHash: envelope.evidenceHash,
      nonce: envelope.nonce,
      correlationId,
    };

    await this.client.query(
      `
        INSERT INTO event_log (
          actor,
          event_type,
          aggregate_type,
          aggregate_id,
          correlation_id,
          payload
        )
        VALUES ($1, 'ORACLE_EVENT_APPLIED', 'ASSET', $2, $3, $4::jsonb)
      `,
      [
        `oracle:${envelope.sourceId}`,
        envelope.assetId,
        correlationId,
        JSON.stringify(domainPayload),
      ],
    );
    await this.client.query(
      `INSERT INTO outbox (topic, payload) VALUES ('domain.oracle.applied.v1', $1::jsonb)`,
      [JSON.stringify(domainPayload)],
    );
  }

  private async findOne(
    sql: string,
    values: readonly unknown[],
  ): Promise<StoredOracleEvent | null> {
    const result = await this.client.query<OracleEventRow>(sql, [...values]);
    const row = result.rows[0];
    return row === undefined ? null : mapStoredEvent(row);
  }
}

function mapStoredEvent(row: OracleEventRow): StoredOracleEvent {
  return {
    id: row.id,
    sourceId: row.source_id,
    eventId: row.event_id,
    status: row.status,
    requestHash: row.request_hash,
    createdAt: toIsoString(row.created_at),
    httpStatus: asHttpStatus(row.http_status),
    responseBody: row.response_body,
  };
}

function asHttpStatus(value: number | null): StoredOracleEvent['httpStatus'] {
  if (value === null || value === 202 || value === 400 || value === 409 || value === 422) {
    return value;
  }
  throw new Error(`Unsupported stored oracle HTTP status: ${value}`);
}

function requireRow<Row>(row: Row | undefined): Row {
  if (row === undefined) {
    throw new Error('Expected PostgreSQL to return the affected oracle event');
  }
  return row;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

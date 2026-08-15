import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { CollateralError } from './collateral.errors.js';
import type {
  CollateralLedger,
  CollateralMovementType,
  CollateralPosition,
} from './collateral.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;

interface OracleEventRow extends QueryResultRow {
  id: string;
  event_id: string;
  status: string;
  event_type: string | null;
  source_id: string | null;
  asset_id: string | null;
  instrument_id: string | null;
  quantity: string | null;
  unit: string | null;
  evidence_hash: string | null;
  correlation_id: string | null;
}

interface AssetRow extends QueryResultRow {
  quantity: string;
  unit: string;
}

interface InstrumentRow extends QueryResultRow {
  circulating_supply: string;
  unit_per_token: string;
  unit: string;
}

interface PositionRow extends QueryResultRow {
  asset_id: string;
  instrument_id: string;
  reserved: string;
  available: string;
  unit: string;
  updated_at: Date | string;
}

interface MovementRow extends PositionRow {
  movement_type: CollateralMovementType;
  quantity: string;
}

export class PostgresCollateralLedger implements CollateralLedger {
  public constructor(private readonly pool: Pool) {}

  public reserve(
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition> {
    return this.change('RESERVE', assetId, instrumentId, quantity, oracleEventId);
  }

  public release(
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition> {
    return this.change('RELEASE', assetId, instrumentId, quantity, oracleEventId);
  }

  public async verifiedAvailable(instrumentId: string): Promise<bigint> {
    assertUuid(instrumentId, 'instrumentId');
    return this.verifiedAvailableWithin(this.pool, instrumentId);
  }

  public async verifiedAvailableWithin(
    executor: Pick<PoolClient, 'query'>,
    instrumentId: string,
  ): Promise<bigint> {
    const result = await executor.query<{ total: string } & QueryResultRow>(
      `
        SELECT coalesce(sum(reserved), 0)::text AS total
        FROM collateral_position
        WHERE instrument_id = $1
      `,
      [instrumentId],
    );
    return BigInt(result.rows[0]?.total ?? '0');
  }

  public releaseWithinTransaction(
    client: PoolClient,
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition> {
    return this.changeWithinTransaction(
      client,
      'RELEASE',
      assetId,
      instrumentId,
      quantity,
      oracleEventId,
    );
  }

  private async change(
    movementType: CollateralMovementType,
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition> {
    assertAssetId(assetId);
    assertUuid(instrumentId, 'instrumentId');
    assertUuid(oracleEventId, 'oracleEventId');
    assertPositiveQuantity(quantity);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await this.changeWithinTransaction(
        client,
        movementType,
        assetId,
        instrumentId,
        quantity,
        oracleEventId,
      );
      await client.query('COMMIT');
      return changed;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async changeWithinTransaction(
    client: PoolClient,
    movementType: CollateralMovementType,
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition> {
    assertAssetId(assetId);
    assertUuid(instrumentId, 'instrumentId');
    assertUuid(oracleEventId, 'oracleEventId');
    assertPositiveQuantity(quantity);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `collateral-oracle:${oracleEventId}`,
    ]);
    const existing = await this.readMovement(client, oracleEventId);
    if (existing !== null) {
      if (
        existing.movement_type !== movementType ||
        existing.asset_id !== assetId ||
        existing.instrument_id !== instrumentId ||
        BigInt(existing.quantity) !== quantity
      ) {
        throw new CollateralError(
          'ORACLE_EVENT_MISMATCH',
          `Oracle event ${oracleEventId} was already applied with another collateral command`,
        );
      }
      return mapPosition(existing);
    }
    const oracleEvent = await this.requireOracleEvent(
      client,
      movementType,
      assetId,
      instrumentId,
      quantity,
      oracleEventId,
    );
    const instrument = await this.lockInstrument(client, instrumentId);
    const asset = await this.lockAsset(client, assetId);
    if (asset.unit !== oracleEvent.unit || instrument.unit !== oracleEvent.unit) {
      throw new CollateralError(
        'ORACLE_EVENT_MISMATCH',
        'Oracle, asset, and instrument units must match',
      );
    }
    const totalReservedBefore = await this.totalReservedForAsset(client, assetId);
    const current = await this.readPosition(client, assetId, instrumentId, true);
    const reservedBefore = current?.reserved ?? 0n;
    const assetQuantity = BigInt(asset.quantity);
    const totalReservedAfter =
      movementType === 'RESERVE' ? totalReservedBefore + quantity : totalReservedBefore - quantity;
    const reservedAfter =
      movementType === 'RESERVE' ? reservedBefore + quantity : reservedBefore - quantity;
    if (movementType === 'RESERVE' && totalReservedAfter > assetQuantity) {
      throw new CollateralError(
        'ASSET_COLLATERAL_EXCEEDED',
        `Reservations for asset ${assetId} exceed its quantity`,
      );
    }
    if (movementType === 'RELEASE' && (current === null || reservedAfter < 0n)) {
      throw new CollateralError(
        'COLLATERAL_RELEASE_EXCEEDS_RESERVED',
        `Release exceeds reserved collateral for ${assetId}/${instrumentId}`,
      );
    }
    if (movementType === 'RELEASE') {
      const collateralAfter = (await this.verifiedAvailableWithin(client, instrumentId)) - quantity;
      const required = BigInt(instrument.circulating_supply) * BigInt(instrument.unit_per_token);
      if (collateralAfter < required) {
        throw new CollateralError(
          'COLLATERAL_SUPPORT_IN_USE',
          `Release would leave instrument ${instrumentId} undercollateralized`,
        );
      }
    }
    const availableAfter = assetQuantity - totalReservedAfter;
    const changed = await this.writePosition(
      client,
      assetId,
      instrumentId,
      reservedAfter,
      availableAfter,
      asset.unit,
      oracleEvent,
    );
    await client.query(
      'UPDATE collateral_position SET available = $2, updated_at = now() WHERE asset_id = $1',
      [assetId, availableAfter.toString()],
    );
    await client.query(
      'UPDATE asset SET encumbrance_status = $2, updated_at = now() WHERE asset_id = $1',
      [assetId, totalReservedAfter === 0n ? 'RELEASED' : 'LOCKED'],
    );
    await client.query(
      `INSERT INTO collateral_position_movements (
         oracle_event_row_id, oracle_event_id, movement_type, asset_id, instrument_id,
         quantity, reserved_before, reserved_after, available_after
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        oracleEvent.id,
        oracleEventId,
        movementType,
        assetId,
        instrumentId,
        quantity.toString(),
        reservedBefore.toString(),
        reservedAfter.toString(),
        availableAfter.toString(),
      ],
    );
    await this.appendAuditEvent(
      client,
      movementType,
      assetId,
      instrumentId,
      quantity,
      oracleEvent,
      changed,
    );
    return changed;
  }

  private async requireOracleEvent(
    client: PoolClient,
    movementType: CollateralMovementType,
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<OracleEventRow> {
    const result = await client.query<OracleEventRow>(
      `
        SELECT
          id::text,
          event_id::text,
          status::text,
          event_type::text,
          source_id,
          asset_id,
          instrument_id::text,
          quantity::text,
          unit,
          evidence_hash,
          correlation_id::text
        FROM oracle_events
        WHERE event_id = $1
      `,
      [oracleEventId],
    );
    if (result.rows.length !== 1) {
      throw new CollateralError(
        'ORACLE_EVENT_NOT_APPLIED',
        `Oracle event ${oracleEventId} is missing or ambiguous`,
      );
    }
    const event = result.rows[0]!;
    if (event.status !== 'APPLIED') {
      throw new CollateralError(
        'ORACLE_EVENT_NOT_APPLIED',
        `Oracle event ${oracleEventId} is not APPLIED`,
      );
    }
    const expectedType = movementType === 'RESERVE' ? 'RECEIPT_LOCKED' : 'GOODS_RELEASED';
    if (
      event.event_type !== expectedType ||
      event.asset_id !== assetId ||
      event.instrument_id !== instrumentId ||
      event.quantity === null ||
      BigInt(event.quantity) !== quantity ||
      event.unit === null ||
      event.source_id === null ||
      event.correlation_id === null
    ) {
      throw new CollateralError(
        'ORACLE_EVENT_MISMATCH',
        `Oracle event ${oracleEventId} does not match the collateral command`,
      );
    }
    return event;
  }

  private async lockInstrument(client: PoolClient, instrumentId: string): Promise<InstrumentRow> {
    const result = await client.query<InstrumentRow>(
      `
        SELECT circulating_supply::text, unit_per_token::text, unit
        FROM instrument
        WHERE id = $1
        FOR UPDATE
      `,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CollateralError('INSTRUMENT_NOT_FOUND', `Instrument ${instrumentId} was not found`);
    }
    return row;
  }

  private async lockAsset(client: PoolClient, assetId: string): Promise<AssetRow> {
    const result = await client.query<AssetRow>(
      'SELECT quantity::text, unit FROM asset WHERE asset_id = $1 FOR UPDATE',
      [assetId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CollateralError('ASSET_NOT_FOUND', `Asset ${assetId} was not found`);
    }
    return row;
  }

  private async totalReservedForAsset(client: PoolClient, assetId: string): Promise<bigint> {
    const result = await client.query<{ total: string } & QueryResultRow>(
      `SELECT coalesce(sum(reserved), 0)::text AS total FROM collateral_position WHERE asset_id = $1`,
      [assetId],
    );
    return BigInt(result.rows[0]?.total ?? '0');
  }

  private async readPosition(
    client: PoolClient,
    assetId: string,
    instrumentId: string,
    lock: boolean,
  ): Promise<{ readonly reserved: bigint } | null> {
    const result = await client.query<{ reserved: string } & QueryResultRow>(
      `
        SELECT reserved::text
        FROM collateral_position
        WHERE asset_id = $1 AND instrument_id = $2
        ${lock ? 'FOR UPDATE' : ''}
      `,
      [assetId, instrumentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { reserved: BigInt(row.reserved) };
  }

  private async writePosition(
    client: PoolClient,
    assetId: string,
    instrumentId: string,
    reserved: bigint,
    available: bigint,
    unit: string,
    event: OracleEventRow,
  ): Promise<CollateralPosition> {
    const proof = {
      oracleEventId: event.event_id,
      sourceId: event.source_id,
      evidenceHash: event.evidence_hash,
    };
    const result = await client.query<PositionRow>(
      `
        INSERT INTO collateral_position (
          asset_id,
          instrument_id,
          reserved,
          available,
          unit,
          verifier_proofs
        )
        VALUES ($1, $2, $3, $4, $5, jsonb_build_array($6::jsonb))
        ON CONFLICT (asset_id, instrument_id) DO UPDATE
        SET reserved = EXCLUDED.reserved,
            available = EXCLUDED.available,
            verifier_proofs = collateral_position.verifier_proofs || EXCLUDED.verifier_proofs,
            updated_at = now()
        RETURNING
          asset_id,
          instrument_id::text,
          reserved::text,
          available::text,
          unit,
          updated_at
      `,
      [
        assetId,
        instrumentId,
        reserved.toString(),
        available.toString(),
        unit,
        JSON.stringify(proof),
      ],
    );
    return mapPosition(result.rows[0]!);
  }

  private async readMovement(
    client: PoolClient,
    oracleEventId: string,
  ): Promise<MovementRow | null> {
    const result = await client.query<MovementRow>(
      `
        SELECT
          movement.asset_id,
          movement.instrument_id::text,
          movement.movement_type,
          movement.quantity::text,
          movement.reserved_after::text AS reserved,
          movement.available_after::text AS available,
          asset.unit,
          movement.occurred_at AS updated_at
        FROM collateral_position_movements AS movement
        JOIN asset ON asset.asset_id = movement.asset_id
        WHERE movement.oracle_event_id = $1
      `,
      [oracleEventId],
    );
    return result.rows[0] ?? null;
  }

  private async appendAuditEvent(
    client: PoolClient,
    movementType: CollateralMovementType,
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEvent: OracleEventRow,
    position: CollateralPosition,
  ): Promise<void> {
    const nonceResult = await client.query<{ nonce: string } & QueryResultRow>(
      `SELECT nextval(pg_get_serial_sequence('event_log', 'id'))::text AS nonce`,
    );
    const nonce = nonceResult.rows[0]?.nonce;
    if (nonce === undefined) throw new Error('Could not allocate collateral event nonce');
    const eventId = randomUUID();
    const eventType = movementType === 'RESERVE' ? 'COLLATERAL_RESERVED' : 'COLLATERAL_RELEASED';
    const envelope = {
      eventId,
      nonce,
      schemaVersion: '1',
      eventType,
      occurredAt: position.updatedAt,
      instrumentId,
      assetId,
      quantity: quantity.toString(),
      unit: position.unit,
      oracleEventId: oracleEvent.event_id,
      sourceId: oracleEvent.source_id,
      reserved: position.reserved.toString(),
      available: position.available.toString(),
      correlationId: oracleEvent.correlation_id,
    };
    await client.query(
      `
        INSERT INTO event_log (
          id,
          occurred_at,
          actor,
          event_type,
          aggregate_type,
          aggregate_id,
          correlation_id,
          payload
        )
        VALUES ($1, $2, $3, $4, 'COLLATERAL_POSITION', $5, $6, $7::jsonb)
      `,
      [
        nonce,
        position.updatedAt,
        `oracle:${oracleEvent.source_id}`,
        eventType,
        `${assetId}:${instrumentId}`,
        oracleEvent.correlation_id,
        JSON.stringify(envelope),
      ],
    );
    await client.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)', [
      movementType === 'RESERVE'
        ? 'domain.collateral.reserved.v1'
        : 'domain.collateral.released.v1',
      JSON.stringify(envelope),
    ]);
  }
}

function mapPosition(row: PositionRow): CollateralPosition {
  return {
    assetId: row.asset_id,
    instrumentId: row.instrument_id,
    reserved: BigInt(row.reserved),
    available: BigInt(row.available),
    unit: row.unit,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : new Date(row.updated_at).toISOString(),
  };
}

function assertPositiveQuantity(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_NUMERIC_38) {
    throw new CollateralError(
      'INVALID_COLLATERAL_ARGUMENT',
      'quantity must be a positive bigint within NUMERIC(38,0)',
    );
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CollateralError('INVALID_COLLATERAL_ARGUMENT', `${field} must be a UUID`);
  }
}

function assertAssetId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
    throw new CollateralError('INVALID_COLLATERAL_ARGUMENT', 'assetId is invalid');
  }
}

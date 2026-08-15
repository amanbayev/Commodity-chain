import { createHash } from 'node:crypto';

import type { EzrRegistry, OracleEventEnvelope, Receipt } from '@commodity-chain/adapters';
import type { Pool, QueryResultRow } from 'pg';

import { AppliedOracleEventConsumer } from '../collateral/applied-oracle-event.consumer.js';
import { CollateralCoverageConsumer } from '../instrument/collateral-coverage.consumer.js';
import { canonicalizeJson } from '../oracle-gateway/canonical-json.js';
import { GoodsReleasedRedemptionConsumer } from '../redemption/redemption.consumers.js';
import { RedemptionService } from '../redemption/redemption.service.js';
import type { RedemptionStatus } from '../redemption/redemption.types.js';
import { ElevatorError } from './elevator.errors.js';
import type {
  CursorPage,
  ElevatorDashboardView,
  ElevatorOracleActionResult,
  ElevatorOracleEventView,
  ElevatorRedemptionView,
  ElevatorShipmentDetail,
  ElevatorShipmentView,
  OraclePayloadPreview,
  VerificationRequestDetail,
  VerificationRequestView,
} from './elevator.types.js';

const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ReceiptRow extends QueryResultRow {
  receipt_id: string;
  owner: string;
  commodity: string;
  quantity: string;
  unit: string;
  elevator_id: string;
  status: Receipt['status'];
  instrument_id: string;
  redemption_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  ticker: string | null;
  passport?: Readonly<Record<string, unknown>>;
}

interface ShipmentRow extends QueryResultRow {
  id: string;
  holder_party_id: string;
  instrument_id: string;
  quantity: string;
  status: RedemptionStatus;
  elevator_id: string;
  requested_date: Date | string;
  recipient: string;
  transport: string;
  proofs: readonly Readonly<Record<string, unknown>>[];
  delivery_deadline: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  unit_per_token: string;
  circulating_supply: string;
  ticker: string | null;
  receipt_id: string | null;
  receipt_owner: string | null;
  receipt_commodity: string | null;
  receipt_quantity: string | null;
  receipt_unit: string | null;
  receipt_status: Receipt['status'] | null;
  receipt_redemption_id: string | null;
  receipt_created_at: Date | string | null;
  receipt_updated_at: Date | string | null;
  collateral_reserved: string | null;
}

export interface OracleRow extends QueryResultRow {
  id: string;
  source_id: string;
  event_id: string;
  schema_version: string;
  instrument_id: string;
  asset_id: string;
  event_type: OracleEventEnvelope['eventType'];
  quantity: string;
  unit: string;
  observed_at: Date | string;
  effective_at: Date | string;
  evidence_hash: string;
  nonce: string;
  signature: OracleEventEnvelope['signature'];
  extensions: Readonly<Record<string, unknown>>;
  redemption_id: string | null;
  status: string;
  failure_code: string | null;
  failure_details: readonly Readonly<Record<string, unknown>>[] | null;
  correlation_id: string | null;
  created_at: Date | string;
}

export interface ElevatorServiceOptions {
  readonly sourceId: string;
}

export class ElevatorService {
  public constructor(
    private readonly pool: Pool,
    private readonly registry: EzrRegistry,
    private readonly collateralEvents: AppliedOracleEventConsumer,
    private readonly coverageEvents: CollateralCoverageConsumer,
    private readonly redemptions: RedemptionService,
    private readonly goodsReleased: GoodsReleasedRedemptionConsumer,
    private readonly options: ElevatorServiceOptions,
  ) {}

  public async dashboard(elevatorId: string): Promise<ElevatorDashboardView> {
    assertExternalId(elevatorId, 'elevatorId');
    const [counts, requests, shipments, events, incidents] = await Promise.all([
      this.pool.query<
        {
          on_review: number;
          reserved_quantity: string;
          active_receipts: number;
          awaiting_shipment: number;
        } & QueryResultRow
      >(
        `SELECT
           count(*) FILTER (WHERE receipt.status = 'AVAILABLE')::int AS on_review,
           coalesce(sum(receipt.quantity) FILTER (WHERE receipt.status = 'LOCKED'), 0)::text AS reserved_quantity,
           count(*) FILTER (WHERE receipt.status IN ('AVAILABLE', 'LOCKED'))::int AS active_receipts,
           (SELECT count(*)::int FROM redemption_orders
             WHERE elevator_id = $1 AND status IN ('TOKENS_LOCKED', 'IN_DELIVERY')) AS awaiting_shipment
         FROM mock_ezr_receipts AS receipt WHERE receipt.elevator_id = $1`,
        [elevatorId],
      ),
      this.listVerificationRequests(elevatorId, undefined, 8),
      this.listShipments(elevatorId, undefined, 4),
      this.listOracleEvents(elevatorId, undefined, 4),
      this.readIncidents(elevatorId, 5),
    ]);
    const count = counts.rows[0];
    if (count === undefined) throw new Error('Elevator dashboard aggregate was not returned');
    return {
      elevatorId,
      onReview: count.on_review,
      reservedQuantity: BigInt(count.reserved_quantity),
      awaitingShipment: count.awaiting_shipment,
      activeReceipts: count.active_receipts,
      verificationRequests: requests.items,
      shipments: shipments.items,
      ...(incidents.length === 0 ? {} : { incidents }),
      recentEvents: events.items,
    };
  }

  public async listVerificationRequests(
    elevatorId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<VerificationRequestView>> {
    assertExternalId(elevatorId, 'elevatorId');
    assertLimit(limit);
    const decoded = decodeCursor(cursor);
    const result = await this.pool.query<ReceiptRow>(
      `SELECT receipt.*, receipt.quantity::text,
              instrument.extensions ->> 'ticker' AS ticker
       FROM mock_ezr_receipts AS receipt
       LEFT JOIN instrument ON instrument.id = receipt.instrument_id
       WHERE receipt.elevator_id = $1
         AND ($2::timestamptz IS NULL OR (receipt.updated_at, receipt.receipt_id) < ($2, $3::uuid))
       ORDER BY receipt.updated_at DESC, receipt.receipt_id DESC LIMIT $4`,
      [elevatorId, decoded?.at ?? null, decoded?.id ?? null, limit + 1],
    );
    return page(
      result.rows,
      limit,
      (row) => mapVerification(row),
      (row) => ({
        at: iso(row.updated_at),
        id: row.receipt_id,
      }),
    );
  }

  public async getVerificationRequest(
    elevatorId: string,
    requestId: string,
  ): Promise<VerificationRequestDetail> {
    const row = await this.requireReceipt(elevatorId, requestId);
    const receipt = mapReceipt(row);
    const passport = row.passport ?? {};
    const underlying = record(passport['underlyingAsset']);
    const documents = Array.isArray(underlying?.['documents'])
      ? underlying['documents'].map((document) => ({ ...record(document), status: 'PROVIDED' }))
      : [];
    return {
      request: mapVerification(row),
      receipt,
      requestedQuantity: receipt.quantity,
      availableQuantity: receipt.status === 'AVAILABLE' ? receipt.quantity : 0n,
      documents,
      checks: verificationChecks(receipt, underlying),
      eventPreview: preview(receipt, 'RECEIPT_LOCKED', this.options.sourceId),
    };
  }

  public async reserve(
    elevatorId: string,
    requestId: string,
    correlationId: string,
  ): Promise<ElevatorOracleActionResult> {
    const current = await this.requireReceipt(elevatorId, requestId);
    let receipt = mapReceipt(current);
    if (receipt.status === 'AVAILABLE') {
      receipt = await this.registry.lockReceipt(receipt.receiptId, receipt.instrumentId);
    } else if (receipt.status !== 'LOCKED') {
      throw new ElevatorError('INVALID_STATUS', 'Released receipt cannot be reserved', 409);
    }
    const stored = await this.requireLatestOracle(receipt.receiptId, 'RECEIPT_LOCKED');
    if (stored.view.status === 'APPLIED') {
      await this.collateralEvents.handle(domainEvent(stored.row));
      await this.coverageEvents.handle({
        eventId: stored.row.event_id,
        nonce: stored.row.nonce,
        instrumentId: stored.row.instrument_id,
        correlationId: stored.row.correlation_id ?? correlationId,
      });
    }
    return { receipt, oracleEvent: stored.view };
  }

  public async listShipments(
    elevatorId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<ElevatorShipmentView>> {
    assertExternalId(elevatorId, 'elevatorId');
    assertLimit(limit);
    const decoded = decodeCursor(cursor);
    const rows = await this.readShipmentRows(elevatorId, undefined, decoded, limit + 1);
    return page(rows, limit, mapShipment, (row) => ({ at: iso(row.updated_at), id: row.id }));
  }

  public async getShipment(
    elevatorId: string,
    redemptionId: string,
  ): Promise<ElevatorShipmentDetail> {
    const row = await this.requireShipment(elevatorId, redemptionId);
    const receipt = shipmentReceipt(row);
    const underlying = BigInt(row.quantity) * BigInt(row.unit_per_token);
    const collateralBefore = BigInt(row.collateral_reserved ?? '0');
    const supplyBefore = BigInt(row.circulating_supply);
    const tokens = BigInt(row.quantity);
    return {
      shipment: mapShipment(row),
      receipt,
      changes: {
        collateralBefore,
        collateralAfter: collateralBefore >= underlying ? collateralBefore - underlying : 0n,
        supplyBefore,
        supplyAfter: supplyBefore >= tokens ? supplyBefore - tokens : 0n,
      },
      eventPreview: preview(
        { ...receipt, status: 'RELEASED', redemptionId },
        'GOODS_RELEASED',
        this.options.sourceId,
      ),
    };
  }

  public async confirmShipment(
    elevatorId: string,
    redemptionId: string,
    correlationId: string,
  ): Promise<ElevatorOracleActionResult> {
    const current = await this.requireShipment(elevatorId, redemptionId);
    if (current.receipt_status === 'RELEASED' && current.receipt_redemption_id === redemptionId) {
      if (current.receipt_id === null) throw new Error('Shipment receipt invariant violated');
      const stored = await this.requireLatestOracle(current.receipt_id, 'GOODS_RELEASED');
      return {
        receipt: shipmentReceipt(current),
        oracleEvent: stored.view,
        redemption: mapRedemption(current),
      };
    }
    const receiptId = await this.redemptions.prepareDelivery(redemptionId, correlationId);
    const receipt = await this.registry.releaseReceipt(receiptId, redemptionId);
    const stored = await this.requireLatestOracle(receiptId, 'GOODS_RELEASED');
    if (stored.view.status === 'APPLIED') {
      await this.goodsReleased.handle({
        ...domainEvent(stored.row),
        correlationId: stored.row.correlation_id ?? correlationId,
      });
    }
    const after = await this.requireShipment(elevatorId, redemptionId);
    return { receipt, oracleEvent: stored.view, redemption: mapRedemption(after) };
  }

  public async listOracleEvents(
    elevatorId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<ElevatorOracleEventView>> {
    assertExternalId(elevatorId, 'elevatorId');
    assertLimit(limit);
    const decoded = decodeCursor(cursor);
    const result = await this.pool.query<OracleRow>(
      `${ORACLE_SELECT}
       JOIN mock_ezr_receipts AS receipt ON receipt.receipt_id::text = event.asset_id
       WHERE receipt.elevator_id = $1 AND event.source_id = $2
         AND ($3::timestamptz IS NULL OR (event.created_at, event.id) < ($3, $4::bigint))
         AND event.event_id IS NOT NULL AND event.instrument_id IS NOT NULL
         AND event.asset_id IS NOT NULL AND event.event_type IS NOT NULL
       ORDER BY event.created_at DESC, event.id DESC LIMIT $5`,
      [elevatorId, this.options.sourceId, decoded?.at ?? null, decoded?.id ?? null, limit + 1],
    );
    return page(result.rows, limit, mapOracle, (row) => ({ at: iso(row.created_at), id: row.id }));
  }

  private async requireReceipt(elevatorId: string, requestId: string): Promise<ReceiptRow> {
    assertExternalId(elevatorId, 'elevatorId');
    assertUuid(requestId, 'requestId');
    const result = await this.pool.query<ReceiptRow>(
      `SELECT receipt.*, receipt.quantity::text,
              instrument.extensions ->> 'ticker' AS ticker,
              passport.passport
       FROM mock_ezr_receipts AS receipt
       LEFT JOIN instrument ON instrument.id = receipt.instrument_id
       LEFT JOIN instrument_passport_versions AS passport
         ON passport.instrument_id = instrument.id AND passport.version = instrument.version
       WHERE receipt.elevator_id = $1 AND receipt.receipt_id = $2`,
      [elevatorId, requestId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new ElevatorError('RESOURCE_NOT_FOUND', 'Verification request was not found', 404);
    return row;
  }

  private async requireShipment(elevatorId: string, redemptionId: string): Promise<ShipmentRow> {
    assertExternalId(elevatorId, 'elevatorId');
    assertUuid(redemptionId, 'redemptionId');
    const rows = await this.readShipmentRows(elevatorId, redemptionId, null, 1);
    const row = rows[0];
    if (row === undefined)
      throw new ElevatorError('RESOURCE_NOT_FOUND', 'Shipment was not found', 404);
    if (row.receipt_id === null)
      throw new ElevatorError('RESOURCE_NOT_FOUND', 'No matching locked receipt is available', 404);
    return row;
  }

  private async readShipmentRows(
    elevatorId: string,
    redemptionId: string | undefined,
    cursor: { at: string; id: string } | null,
    limit: number,
  ): Promise<ShipmentRow[]> {
    const result = await this.pool.query<ShipmentRow>(
      `SELECT redemption.id::text, redemption.holder_party_id::text, redemption.instrument_id::text,
              redemption.quantity::text, redemption.status::text, redemption.elevator_id,
              redemption.requested_date, redemption.recipient, redemption.transport,
              redemption.proofs, redemption.delivery_deadline, redemption.created_at,
              redemption.updated_at, redemption.completed_at,
              instrument.unit_per_token::text, instrument.circulating_supply::text,
              instrument.extensions ->> 'ticker' AS ticker,
              receipt.receipt_id::text, receipt.owner AS receipt_owner,
              receipt.commodity AS receipt_commodity, receipt.quantity::text AS receipt_quantity,
              receipt.unit AS receipt_unit, receipt.status AS receipt_status,
              receipt.redemption_id AS receipt_redemption_id,
              receipt.created_at AS receipt_created_at, receipt.updated_at AS receipt_updated_at,
              position.reserved::text AS collateral_reserved
       FROM redemption_orders AS redemption
       JOIN instrument ON instrument.id = redemption.instrument_id
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM mock_ezr_receipts AS candidate
         WHERE candidate.elevator_id = redemption.elevator_id
           AND candidate.instrument_id = redemption.instrument_id
           AND candidate.quantity = redemption.quantity * instrument.unit_per_token
           AND (candidate.receipt_id::text = redemption.asset_id OR
                (redemption.asset_id IS NULL AND candidate.status = 'LOCKED'))
         ORDER BY (candidate.receipt_id::text = redemption.asset_id) DESC,
                  candidate.created_at, candidate.receipt_id LIMIT 1
       ) AS receipt ON true
       LEFT JOIN collateral_position AS position
         ON position.asset_id = receipt.receipt_id::text AND position.instrument_id = redemption.instrument_id
       WHERE redemption.elevator_id = $1
         AND ($2::uuid IS NULL OR redemption.id = $2)
         AND ($3::timestamptz IS NULL OR (redemption.updated_at, redemption.id) < ($3, $4::uuid))
       ORDER BY redemption.updated_at DESC, redemption.id DESC LIMIT $5`,
      [elevatorId, redemptionId ?? null, cursor?.at ?? null, cursor?.id ?? null, limit],
    );
    return result.rows;
  }

  private async requireLatestOracle(
    assetId: string,
    eventType: 'RECEIPT_LOCKED' | 'GOODS_RELEASED',
  ): Promise<{ row: OracleRow; view: ElevatorOracleEventView }> {
    const result = await this.pool.query<OracleRow>(
      `${ORACLE_SELECT}
       WHERE event.source_id = $1 AND event.asset_id = $2 AND event.event_type = $3
       ORDER BY event.created_at DESC, event.id DESC LIMIT 1`,
      [this.options.sourceId, assetId, eventType],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new ElevatorError('RESOURCE_NOT_FOUND', 'Oracle event was not recorded', 404);
    return { row, view: mapOracle(row) };
  }

  private async readIncidents(elevatorId: string, limit: number) {
    const result = await this.pool.query<
      {
        id: string;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        occurred_at: Date | string;
        message: string | null;
      } & QueryResultRow
    >(
      `SELECT log.id::text, log.event_type, log.aggregate_type, log.aggregate_id,
              log.occurred_at, log.payload ->> 'message' AS message
       FROM event_log AS log
       WHERE log.event_type = 'INCIDENT'
         AND EXISTS (
           SELECT 1 FROM mock_ezr_receipts AS receipt
           WHERE receipt.elevator_id = $1
             AND (receipt.receipt_id::text = log.aggregate_id OR receipt.redemption_id = log.aggregate_id)
         )
       ORDER BY log.id DESC LIMIT $2`,
      [elevatorId, limit],
    );
    return result.rows.map((row) => ({
      id: BigInt(row.id),
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      ...(row.message === null ? {} : { message: row.message }),
      occurredAt: iso(row.occurred_at),
    }));
  }
}

const ORACLE_SELECT = `SELECT event.id::text, event.source_id, event.event_id::text,
  event.schema_version, event.instrument_id::text, event.asset_id, event.event_type::text,
  event.quantity::text, event.unit, event.observed_at, event.effective_at,
  event.evidence_hash, event.nonce::text, event.signature, event.extensions,
  event.redemption_id, event.status::text, event.failure_code, event.failure_details,
  event.correlation_id::text, event.created_at FROM oracle_events AS event`;

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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapVerification(row: ReceiptRow): VerificationRequestView {
  return {
    requestId: row.receipt_id,
    applicant: row.owner,
    instrumentId: row.instrument_id,
    ...(row.ticker === null ? {} : { ticker: row.ticker }),
    commodity: row.commodity,
    quantity: BigInt(row.quantity),
    unit: row.unit,
    status:
      row.status === 'AVAILABLE'
        ? 'REQUIRES_REVIEW'
        : row.status === 'LOCKED'
          ? 'RESERVED'
          : 'RELEASED',
    receiptStatus: row.status,
    updatedAt: iso(row.updated_at),
  };
}

function mapRedemption(row: ShipmentRow): ElevatorRedemptionView {
  return {
    id: row.id,
    holder: row.holder_party_id,
    instrumentId: row.instrument_id,
    quantity: BigInt(row.quantity),
    method: 'PHYSICAL_DELIVERY',
    status: row.status,
    delivery: {
      elevatorId: row.elevator_id,
      requestedDate: isoDate(row.requested_date),
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

function mapShipment(row: ShipmentRow): ElevatorShipmentView {
  return {
    redemption: mapRedemption(row),
    instrumentTicker: row.ticker ?? row.instrument_id,
    underlyingQuantity: BigInt(row.quantity) * BigInt(row.unit_per_token),
  };
}

function shipmentReceipt(row: ShipmentRow): Receipt {
  if (
    row.receipt_id === null ||
    row.receipt_owner === null ||
    row.receipt_commodity === null ||
    row.receipt_quantity === null ||
    row.receipt_unit === null ||
    row.receipt_status === null ||
    row.receipt_created_at === null ||
    row.receipt_updated_at === null
  )
    throw new ElevatorError('RESOURCE_NOT_FOUND', 'Shipment receipt was not found', 404);
  return {
    receiptId: row.receipt_id,
    owner: row.receipt_owner,
    commodity: row.receipt_commodity,
    quantity: BigInt(row.receipt_quantity),
    unit: row.receipt_unit,
    elevatorId: row.elevator_id,
    status: row.receipt_status,
    instrumentId: row.instrument_id,
    ...(row.receipt_redemption_id === null ? {} : { redemptionId: row.receipt_redemption_id }),
    createdAt: iso(row.receipt_created_at),
    updatedAt: iso(row.receipt_updated_at),
  };
}

function preview(
  receipt: Receipt,
  eventType: 'RECEIPT_LOCKED' | 'GOODS_RELEASED',
  sourceId: string,
): OraclePayloadPreview {
  const nextReceipt = {
    ...receipt,
    status: eventType === 'RECEIPT_LOCKED' ? ('LOCKED' as const) : ('RELEASED' as const),
  };
  return {
    schemaVersion: '1',
    instrumentId: receipt.instrumentId,
    assetId: receipt.receiptId,
    eventType,
    quantity: receipt.quantity,
    unit: receipt.unit,
    sourceId,
    ...(receipt.redemptionId === undefined ? {} : { redemptionId: receipt.redemptionId }),
    evidenceHash: evidenceHash(nextReceipt, eventType),
  };
}

function evidenceHash(receipt: Receipt, eventType: string): string {
  const evidence = canonicalizeJson({
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

export function mapOracle(row: OracleRow): ElevatorOracleEventView {
  const envelope: OracleEventEnvelope = {
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    instrumentId: row.instrument_id,
    assetId: row.asset_id,
    eventType: row.event_type,
    quantity: row.quantity,
    unit: row.unit,
    observedAt: iso(row.observed_at),
    effectiveAt: iso(row.effective_at),
    sourceId: row.source_id,
    ...(row.redemption_id === null ? {} : { redemptionId: row.redemption_id }),
    evidenceHash: row.evidence_hash,
    nonce: Number(BigInt(row.nonce)),
    signature: row.signature,
    ...(Object.keys(row.extensions).length === 0 ? {} : { extensions: row.extensions }),
  };
  return {
    envelope,
    status: row.status,
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.failure_details === null ? {} : { failureDetails: row.failure_details }),
    receivedAt: iso(row.created_at),
  };
}

function domainEvent(row: OracleRow) {
  return {
    eventId: row.event_id,
    instrumentId: row.instrument_id,
    assetId: row.asset_id,
    eventType: row.event_type,
    quantity: row.quantity,
    ...(row.redemption_id === null ? {} : { redemptionId: row.redemption_id }),
  };
}

function verificationChecks(
  receipt: Receipt,
  underlying: Readonly<Record<string, unknown>> | null,
) {
  return [
    {
      code: 'OWNERSHIP',
      label: 'Право на актив',
      status: receipt.owner.length > 0 ? 'PASSED' : 'PENDING',
    },
    {
      code: 'STOCK',
      label: 'Наличие на складе',
      status: receipt.quantity > 0n ? 'PASSED' : 'FAILED',
    },
    {
      code: 'QUALITY',
      label: 'Качество',
      status: underlying?.['grade'] === undefined ? 'PENDING' : 'PASSED',
    },
    {
      code: 'ENCUMBRANCE',
      label: 'Отсутствие обременений',
      status: receipt.status === 'AVAILABLE' ? 'PASSED' : 'PENDING',
    },
  ];
}

function page<Row, View>(
  rows: readonly Row[],
  limit: number,
  mapper: (row: Row) => View,
  cursor: (row: Row) => { at: string; id: string },
): CursorPage<View> {
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(mapper),
    page: {
      limit,
      hasMore,
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(cursor(last)) } : {}),
    },
  };
}

function encodeCursor(value: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeCursor(value: string | undefined): { at: string; id: string } | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('at' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.at !== 'string' ||
      typeof parsed.id !== 'string'
    )
      throw new Error();
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch {
    throw new ElevatorError('VALIDATION_ERROR', 'cursor is invalid', 400);
  }
}
function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw new ElevatorError('VALIDATION_ERROR', 'limit must be between 1 and 200', 400);
}
function assertExternalId(value: string, field: string): void {
  if (!EXTERNAL_ID.test(value))
    throw new ElevatorError('VALIDATION_ERROR', `${field} is invalid`, 400);
}
function assertUuid(value: string, field: string): void {
  if (!UUID.test(value))
    throw new ElevatorError('VALIDATION_ERROR', `${field} must be a UUID`, 400);
}
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function isoDate(value: Date | string): string {
  return iso(value).slice(0, 10);
}
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

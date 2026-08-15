export type ReceiptStatus = 'AVAILABLE' | 'LOCKED' | 'RELEASED';

export interface Receipt {
  readonly receiptId: string;
  readonly owner: string;
  readonly commodity: string;
  readonly quantity: bigint;
  readonly unit: string;
  readonly elevatorId: string;
  readonly status: ReceiptStatus;
  readonly instrumentId: string;
  readonly redemptionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EzrRegistry {
  issueReceipt(
    owner: string,
    commodity: string,
    quantity: bigint,
    elevatorId: string,
  ): Promise<Receipt>;
  lockReceipt(receiptId: string, instrumentId: string): Promise<Receipt>;
  releaseReceipt(receiptId: string, redemptionId: string): Promise<Receipt>;
  getReceipt(receiptId: string): Promise<Receipt | null>;
}

export type EzrRegistryErrorCode =
  | 'ALREADY_ENCUMBERED'
  | 'DELIVERY_FAILED'
  | 'INSTRUMENT_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'RECEIPT_NOT_FOUND';

export class EzrRegistryError extends Error {
  public constructor(
    public readonly code: EzrRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EzrRegistryError';
  }
}

export type OracleEventType =
  | 'COLLATERAL_RESERVED'
  | 'RECEIPT_LOCKED'
  | 'QUALITY_CONFIRMED'
  | 'STOCK_UPDATED'
  | 'GOODS_RELEASED'
  | 'REVENUE_RECEIVED';

export interface OracleSignature {
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly value: string;
}

export interface UnsignedOracleEventEnvelope {
  readonly eventId: string;
  readonly schemaVersion: string;
  readonly instrumentId: string;
  readonly assetId: string;
  readonly eventType: OracleEventType;
  readonly quantity: string;
  readonly unit: string;
  readonly observedAt: string;
  readonly effectiveAt: string;
  readonly sourceId: string;
  readonly redemptionId?: string;
  readonly evidenceHash: string;
  readonly nonce: number;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface OracleEventEnvelope extends UnsignedOracleEventEnvelope {
  readonly signature: OracleSignature;
}

export interface OracleEventReceipt {
  readonly eventId: string;
  readonly acceptedAt: string;
  readonly status:
    | 'RECEIVED'
    | 'SCHEMA_VALIDATED'
    | 'SIGNATURE_VALIDATED'
    | 'POLICY_VALIDATED'
    | 'APPLIED'
    | 'DUPLICATE'
    | 'STALE'
    | 'QUARANTINED'
    | 'REJECTED';
  readonly replayed: boolean;
}

export interface OraclePublishContext {
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface OracleEventPublisher {
  publish(
    envelope: OracleEventEnvelope,
    context: OraclePublishContext,
  ): Promise<OracleEventReceipt>;
}

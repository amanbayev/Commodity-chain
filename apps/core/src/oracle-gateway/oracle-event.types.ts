export const ORACLE_EVENT_TYPES = [
  'COLLATERAL_RESERVED',
  'RECEIPT_LOCKED',
  'QUALITY_CONFIRMED',
  'STOCK_UPDATED',
  'GOODS_RELEASED',
  'REVENUE_RECEIVED',
] as const;

export type OracleEventType = (typeof ORACLE_EVENT_TYPES)[number];

export const ORACLE_PROCESSING_STATUSES = [
  'RECEIVED',
  'SCHEMA_VALIDATED',
  'SIGNATURE_VALIDATED',
  'POLICY_VALIDATED',
  'APPLIED',
  'DUPLICATE',
  'STALE',
  'QUARANTINED',
  'REJECTED',
] as const;

export type OracleProcessingStatus = (typeof ORACLE_PROCESSING_STATUSES)[number];

export interface OracleSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly value: string;
}

export interface OracleEventEnvelope {
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
  readonly signature: OracleSignature;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface OracleEventReceipt {
  readonly eventId: string;
  readonly acceptedAt: string;
  readonly status: OracleProcessingStatus;
  readonly replayed: boolean;
}

export type OracleErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ORACLE_SIGNATURE_INVALID'
  | 'ORACLE_SOURCE_UNKNOWN'
  | 'ORACLE_SOURCE_KEY_REVOKED'
  | 'ORACLE_NONCE_INVALID'
  | 'ORACLE_NONCE_GAP'
  | 'ORACLE_EVENT_STALE'
  | 'INTERNAL_ERROR';

export interface OracleErrorDetail {
  readonly field?: string;
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OracleErrorResponse {
  readonly code: OracleErrorCode;
  readonly message: string;
  readonly correlationId: string;
  readonly details: readonly OracleErrorDetail[];
}

export interface AcceptOracleEventCommand {
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly detachedSignature: string;
}

export interface AcceptOracleEventResult {
  readonly status: OracleProcessingStatus;
  readonly httpStatus: 202 | 400 | 409 | 422;
  readonly body: OracleEventReceipt | OracleErrorResponse;
  readonly replayed: boolean;
}

export interface ValidationIssue {
  readonly field?: string;
  readonly reason: string;
}

export type OracleEnvelopeValidation =
  | { readonly valid: true; readonly value: OracleEventEnvelope }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

export interface OracleEnvelopeValidator {
  validate(payload: unknown): OracleEnvelopeValidation;
}

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
};

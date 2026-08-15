export const REDEMPTION_STATUSES = [
  'CREATED',
  'TOKENS_LOCKED',
  'IN_DELIVERY',
  'COMPLETED',
  'CANCELLED',
  'EXCEPTION',
  'QUARANTINED',
] as const;

export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export interface PhysicalDeliveryDetails {
  readonly elevatorId: string;
  readonly requestedDate: string;
  readonly recipient: string;
  readonly transport: string;
}

export interface CreateRedemptionCommand {
  readonly holderId: string;
  readonly instrumentId: string;
  readonly quantity: bigint;
  readonly method: 'PHYSICAL_DELIVERY';
  readonly delivery: PhysicalDeliveryDetails;
  readonly proofs: readonly Readonly<Record<string, unknown>>[];
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface CancelRedemptionCommand {
  readonly redemptionId: string;
  readonly holderId: string;
  readonly correlationId: string;
}

export interface RedemptionView {
  readonly id: string;
  readonly holder: string;
  readonly instrumentId: string;
  readonly quantity: string;
  readonly method: 'PHYSICAL_DELIVERY';
  readonly status: RedemptionStatus;
  readonly delivery: PhysicalDeliveryDetails;
  readonly proofs: readonly Readonly<Record<string, unknown>>[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deliveryDeadline: string;
  readonly completedAt?: string;
}

export interface RedemptionErrorBody {
  readonly code: RedemptionErrorCode;
  readonly message: string;
  readonly correlationId: string;
  readonly details: readonly { readonly field?: string; readonly reason: string }[];
}

export type RedemptionErrorCode =
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_STATUS'
  | 'INVALID_TRANSITION'
  | 'INSUFFICIENT_FUNDS'
  | 'REDEMPTION_NOT_ALLOWED'
  | 'REDEMPTION_LOT_INVALID'
  | 'REDEMPTION_NOT_CANCELLABLE'
  | 'REDEMPTION_QUANTITY_MISMATCH'
  | 'REDEMPTION_DELIVERY_EXCEPTION';

export interface RedemptionExecutionResult {
  readonly httpStatus: 200 | 202 | 400 | 404 | 409 | 422;
  readonly replayed: boolean;
  readonly body: RedemptionView | RedemptionErrorBody;
}

export interface RedemptionTokensLockedEvent {
  readonly redemptionId: string;
  readonly instrumentId: string;
  readonly quantity: string;
  readonly correlationId: string;
}

export interface RedemptionOracleAppliedEvent {
  readonly eventId: string;
  readonly instrumentId: string;
  readonly assetId: string;
  readonly eventType: string;
  readonly quantity: string;
  readonly redemptionId?: string;
  readonly correlationId: string;
}

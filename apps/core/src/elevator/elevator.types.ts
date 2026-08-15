import type { OracleEventEnvelope, Receipt } from '@commodity-chain/adapters';

import type { RedemptionStatus } from '../redemption/redemption.types.js';

export type VerificationStatus = 'REQUIRES_REVIEW' | 'RESERVED' | 'RELEASED';

export interface VerificationRequestView {
  readonly requestId: string;
  readonly applicant: string;
  readonly instrumentId: string;
  readonly ticker?: string;
  readonly commodity: string;
  readonly quantity: bigint;
  readonly unit: string;
  readonly status: VerificationStatus;
  readonly receiptStatus: Receipt['status'];
  readonly updatedAt: string;
}

export interface OraclePayloadPreview {
  readonly schemaVersion: '1';
  readonly instrumentId: string;
  readonly assetId: string;
  readonly eventType: 'RECEIPT_LOCKED' | 'GOODS_RELEASED';
  readonly quantity: bigint;
  readonly unit: string;
  readonly sourceId: string;
  readonly redemptionId?: string;
  readonly evidenceHash: string;
}

export interface VerificationRequestDetail {
  readonly request: VerificationRequestView;
  readonly receipt: Receipt;
  readonly requestedQuantity: bigint;
  readonly availableQuantity: bigint;
  readonly documents: readonly Readonly<Record<string, unknown>>[];
  readonly checks: readonly Readonly<Record<string, unknown>>[];
  readonly eventPreview: OraclePayloadPreview;
}

export interface ElevatorRedemptionView {
  readonly id: string;
  readonly holder: string;
  readonly instrumentId: string;
  readonly quantity: bigint;
  readonly method: 'PHYSICAL_DELIVERY';
  readonly status: RedemptionStatus;
  readonly delivery: {
    readonly elevatorId: string;
    readonly requestedDate: string;
    readonly recipient: string;
    readonly transport: string;
  };
  readonly proofs: readonly Readonly<Record<string, unknown>>[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deliveryDeadline: string;
  readonly completedAt?: string;
}

export interface ElevatorShipmentView {
  readonly redemption: ElevatorRedemptionView;
  readonly instrumentTicker: string;
  readonly underlyingQuantity: bigint;
}

export interface ElevatorShipmentDetail {
  readonly shipment: ElevatorShipmentView;
  readonly receipt: Receipt;
  readonly changes: {
    readonly collateralBefore: bigint;
    readonly collateralAfter: bigint;
    readonly supplyBefore: bigint;
    readonly supplyAfter: bigint;
  };
  readonly eventPreview: OraclePayloadPreview;
}

export interface ElevatorOracleEventView {
  readonly envelope: OracleEventEnvelope;
  readonly status: string;
  readonly failureCode?: string;
  readonly failureDetails?: readonly Readonly<Record<string, unknown>>[];
  readonly receivedAt: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly nextCursor?: string;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface ElevatorDashboardView {
  readonly elevatorId: string;
  readonly onReview: number;
  readonly reservedQuantity: bigint;
  readonly awaitingShipment: number;
  readonly activeReceipts: number;
  readonly verificationRequests: readonly VerificationRequestView[];
  readonly shipments: readonly ElevatorShipmentView[];
  readonly incidents?: readonly Readonly<Record<string, unknown>>[];
  readonly recentEvents: readonly ElevatorOracleEventView[];
}

export interface ElevatorOracleActionResult {
  readonly receipt: Receipt;
  readonly oracleEvent: ElevatorOracleEventView;
  readonly redemption?: ElevatorRedemptionView;
}

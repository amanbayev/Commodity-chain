export type CollateralMovementType = 'RESERVE' | 'RELEASE';

export interface CollateralPosition {
  readonly assetId: string;
  readonly instrumentId: string;
  readonly reserved: bigint;
  readonly available: bigint;
  readonly unit: string;
  readonly updatedAt: string;
}

export interface CollateralLedger {
  reserve(
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition>;
  release(
    assetId: string,
    instrumentId: string,
    quantity: bigint,
    oracleEventId: string,
  ): Promise<CollateralPosition>;
  verifiedAvailable(instrumentId: string): Promise<bigint>;
}

export interface OracleAppliedDomainEvent {
  readonly eventId: string;
  readonly instrumentId: string;
  readonly assetId: string;
  readonly eventType: string;
  readonly quantity: string;
}

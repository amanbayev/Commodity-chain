export type CollateralErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'INSTRUMENT_NOT_FOUND'
  | 'ORACLE_EVENT_NOT_APPLIED'
  | 'ORACLE_EVENT_MISMATCH'
  | 'ASSET_COLLATERAL_EXCEEDED'
  | 'COLLATERAL_RELEASE_EXCEEDS_RESERVED'
  | 'COLLATERAL_SUPPORT_IN_USE'
  | 'INVALID_COLLATERAL_ARGUMENT';

export class CollateralError extends Error {
  public constructor(
    public readonly code: CollateralErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CollateralError';
  }
}

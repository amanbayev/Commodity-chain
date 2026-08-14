export interface MintCollateralProof {
  readonly assetId: string;
  readonly instrumentId: string;
  readonly reserved: string;
  readonly unit: string;
  readonly evidenceHash: string;
  readonly verifierProofs: readonly unknown[];
}

export interface MintCommand {
  readonly instrumentId: string;
  readonly quantity: bigint;
  readonly unit: string;
  readonly collateralProof: MintCollateralProof;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export type MintErrorCode =
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_STATUS'
  | 'SUPPLY_EXCEEDS_COLLATERAL'
  | 'SUPPLY_CAP_EXCEEDED'
  | 'MINT_ACCOUNT_NOT_CONFIGURED'
  | 'COLLATERAL_PROOF_INVALID';

export interface MintSuccessBody {
  readonly instrumentId: string;
  readonly mintedQuantity: string;
  readonly unit: string;
  readonly totalSupply: string;
  readonly status: 'COLLATERALIZED' | 'ACTIVE';
  readonly mintedAt: string;
}

export interface MintErrorBody {
  readonly code: MintErrorCode;
  readonly message: string;
  readonly correlationId: string;
  readonly details: readonly { readonly field?: string; readonly reason: string }[];
}

export interface MintExecutionResult {
  readonly httpStatus: 201 | 400 | 404 | 409 | 422;
  readonly body: MintSuccessBody | MintErrorBody;
  readonly replayed: boolean;
}

export type InstrumentListingErrorCode =
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'PASSPORT_INCOMPLETE'
  | 'FOUR_EYES_REQUIRED'
  | 'PASSPORT_NOT_PUBLIC'
  | 'PERMISSION_DENIED'
  | 'CONFLICT';

export interface InstrumentErrorDetail {
  readonly field?: string;
  readonly reason: string;
}

export class InstrumentListingError extends Error {
  public constructor(
    public readonly code: InstrumentListingErrorCode,
    message: string,
    public readonly httpStatus: 400 | 403 | 404 | 409 | 422,
    public readonly details: readonly InstrumentErrorDetail[] = [{ reason: message }],
  ) {
    super(message);
    this.name = 'InstrumentListingError';
  }
}

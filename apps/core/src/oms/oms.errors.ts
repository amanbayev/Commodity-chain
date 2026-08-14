export type OmsErrorCode =
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_STATUS'
  | 'INSUFFICIENT_FUNDS'
  | 'PARTICIPANT_NOT_FOUND'
  | 'INSTRUMENT_NOT_TRADABLE'
  | 'ORDER_TYPE_NOT_AVAILABLE'
  | 'ORDER_REJECTED'
  | 'ORDER_NOT_CANCELLABLE';

export class OmsError extends Error {
  public constructor(
    public readonly code: OmsErrorCode,
    message: string,
    public readonly httpStatus: 400 | 404 | 409 | 422,
    public readonly details: readonly {
      readonly field?: string;
      readonly reason: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[] = [{ reason: message }],
  ) {
    super(message);
    this.name = 'OmsError';
  }
}

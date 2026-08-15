import type { RedemptionErrorCode } from './redemption.types.js';

export class RedemptionError extends Error {
  public constructor(
    public readonly code: RedemptionErrorCode,
    message: string,
    public readonly httpStatus: 400 | 404 | 409 | 422,
    public readonly details: readonly { readonly field?: string; readonly reason: string }[] = [
      { reason: message },
    ],
  ) {
    super(message);
    this.name = 'RedemptionError';
  }
}

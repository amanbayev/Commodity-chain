import type { LedgerAccountId, PostingId } from './types.js';

export class LedgerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class LedgerValidationError extends LedgerError {}

export class LedgerAccountNotFoundError extends LedgerError {
  public constructor(accountIds: readonly LedgerAccountId[]) {
    super(`Ledger accounts not found: ${accountIds.join(', ')}`);
  }
}

export class InsufficientBalanceError extends LedgerError {
  public constructor(
    public readonly accountId: LedgerAccountId,
    public readonly available: bigint,
    public readonly required: bigint,
  ) {
    super(
      `Ledger account ${accountId} has ${available.toString()} minor units; ` +
        `${required.toString()} are required`,
    );
  }
}

export class IdempotencyConflictError extends LedgerError {
  public constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used for another posting`);
  }
}

export class AccountPairMismatchError extends LedgerError {}

export class PostingNotFoundError extends LedgerError {
  public constructor(postingId: PostingId) {
    super(`Ledger posting ${postingId} was not found`);
  }
}

export class PostingAlreadyReversedError extends LedgerError {
  public constructor(postingId: PostingId) {
    super(`Ledger posting ${postingId} already has a reversal`);
  }
}

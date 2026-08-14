import { createHash } from 'node:crypto';

import { LedgerValidationError } from './errors.js';
import type { LedgerLegInput, LedgerLegTuple, LedgerMetadata, PostInput } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;

export function assertBigIntAmount(value: unknown, fieldName: string): asserts value is bigint {
  if (typeof value !== 'bigint') {
    throw new LedgerValidationError(`${fieldName} must be a bigint`);
  }

  if (value <= 0n) {
    throw new LedgerValidationError(`${fieldName} must be greater than zero`);
  }

  if (value > MAX_NUMERIC_38) {
    throw new LedgerValidationError(`${fieldName} exceeds PostgreSQL numeric(38,0)`);
  }
}

export function assertUuid(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new LedgerValidationError(`${fieldName} must be a UUID`);
  }
}

export function assertIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw new LedgerValidationError(
      'idempotencyKey must contain 1-128 letters, digits, dots, underscores, colons, or hyphens',
    );
  }
}

export function assertLedgerLegs(legs: readonly LedgerLegInput[]): asserts legs is LedgerLegTuple {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new LedgerValidationError('A posting must contain at least two legs');
  }

  let debits = 0n;
  let credits = 0n;

  legs.forEach((leg, index) => {
    if (leg === null || typeof leg !== 'object') {
      throw new LedgerValidationError(`legs[${index}] must be an object`);
    }

    assertUuid(leg.accountId, `legs[${index}].accountId`);

    if (leg.direction !== 'DEBIT' && leg.direction !== 'CREDIT') {
      throw new LedgerValidationError(`legs[${index}].direction is invalid`);
    }

    assertBigIntAmount(leg.amount, `legs[${index}].amount`);

    if (leg.direction === 'DEBIT') {
      debits += leg.amount;
    } else {
      credits += leg.amount;
    }
  });

  if (debits !== credits) {
    throw new LedgerValidationError('Posting debits must equal posting credits');
  }
}

export function assertPostInput(input: PostInput): void {
  if (input === null || typeof input !== 'object') {
    throw new LedgerValidationError('Posting input must be an object');
  }

  assertIdempotencyKey(input.idempotencyKey);
  assertUuid(input.correlationId, 'correlationId');
  assertLedgerLegs(input.legs);

  if (input.metadata !== undefined) {
    assertMetadata(input.metadata);
  }
}

export function assertMetadata(metadata: unknown): asserts metadata is LedgerMetadata {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new LedgerValidationError('metadata must be an object');
  }
}

function normalizeForJson(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForJson(item)]),
    );
  }

  return value;
}

export function serializeMetadata(metadata: LedgerMetadata | undefined): string {
  const serialized = JSON.stringify(normalizeForJson(metadata ?? {}));
  if (serialized === undefined) {
    throw new LedgerValidationError('metadata cannot be serialized as JSON');
  }
  return serialized;
}

export function postingRequestHash(
  legs: readonly LedgerLegInput[],
  reversalOf: PostingIdLike,
  metadata: LedgerMetadata | undefined,
): Buffer {
  const canonical = {
    legs: legs.map((leg) => ({
      accountId: leg.accountId,
      amount: leg.amount.toString(),
      direction: leg.direction,
    })),
    metadata: normalizeForJson(metadata ?? {}),
    reversalOf,
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest();
}

type PostingIdLike = string | null;

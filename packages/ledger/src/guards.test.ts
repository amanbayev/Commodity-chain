import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { LedgerValidationError } from './errors.js';
import { assertBigIntAmount, assertLedgerLegs } from './guards.js';
import type { LedgerAccountId, LedgerLegInput } from './types.js';

const firstAccountId = randomUUID() as LedgerAccountId;
const secondAccountId = randomUUID() as LedgerAccountId;

describe('ledger amount and posting guards', () => {
  it('rejects number amounts at compile time and at runtime', () => {
    const compileTimeExample: LedgerLegInput = {
      accountId: firstAccountId,
      direction: 'DEBIT',
      // @ts-expect-error Ledger amounts must be bigint.
      amount: 1,
    };

    expect(() => assertBigIntAmount(compileTimeExample.amount as unknown, 'amount')).toThrowError(
      LedgerValidationError,
    );
  });

  it('rejects zero, negative, and values wider than numeric(38,0)', () => {
    expect(() => assertBigIntAmount(0n, 'amount')).toThrowError(LedgerValidationError);
    expect(() => assertBigIntAmount(-1n, 'amount')).toThrowError(LedgerValidationError);
    expect(() => assertBigIntAmount(10n ** 38n, 'amount')).toThrowError(LedgerValidationError);
  });

  it('requires at least two posting legs', () => {
    expect(() =>
      assertLedgerLegs([
        {
          accountId: firstAccountId,
          direction: 'DEBIT',
          amount: 1n,
        },
      ]),
    ).toThrowError('at least two legs');
  });

  it('requires equal debits and credits', () => {
    expect(() =>
      assertLedgerLegs([
        {
          accountId: firstAccountId,
          direction: 'DEBIT',
          amount: 2n,
        },
        {
          accountId: secondAccountId,
          direction: 'CREDIT',
          amount: 1n,
        },
      ]),
    ).toThrowError('debits must equal');
  });

  it('accepts a balanced bigint posting', () => {
    expect(() =>
      assertLedgerLegs([
        {
          accountId: firstAccountId,
          direction: 'DEBIT',
          amount: 25n,
        },
        {
          accountId: secondAccountId,
          direction: 'CREDIT',
          amount: 25n,
        },
      ]),
    ).not.toThrow();
  });
});

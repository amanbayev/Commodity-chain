import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  InsufficientBalanceError,
  LedgerValidationError,
  PostingAlreadyReversedError,
} from './errors.js';
import type { PostgresLedger } from './postgres-ledger.js';
import { createCashLedgerFixture, createTestPool, resetLedgerDatabase } from './test-database.js';
import type { LedgerAccount } from './types.js';

const databaseAvailable = process.env.TEST_DATABASE_URL !== undefined;
const describeDatabase = databaseAvailable ? describe : describe.skip;

describeDatabase('PostgresLedger invariants', () => {
  const pool: Pool = createTestPool();

  beforeEach(async () => {
    await resetLedgerDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls back when an account balance would become negative', async () => {
    const fixture = await createCashLedgerFixture(pool, 100n);

    await expect(
      fixture.ledger.post({
        idempotencyKey: `overspend-${randomUUID()}`,
        correlationId: randomUUID(),
        legs: [
          {
            accountId: fixture.holderAvailable.id,
            direction: 'CREDIT',
            amount: 101n,
          },
          {
            accountId: fixture.issuerResidual.id,
            direction: 'DEBIT',
            amount: 101n,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    await expect(fixture.ledger.balanceOf(fixture.holderAvailable.id)).resolves.toBe(100n);
  });

  it('rejects unbalanced postings atomically', async () => {
    const fixture = await createCashLedgerFixture(pool);
    const before = await postingCount(pool);

    await expect(
      fixture.ledger.post({
        idempotencyKey: `unbalanced-${randomUUID()}`,
        correlationId: randomUUID(),
        legs: [
          {
            accountId: fixture.holderAvailable.id,
            direction: 'DEBIT',
            amount: 2n,
          },
          {
            accountId: fixture.issuerResidual.id,
            direction: 'CREDIT',
            amount: 1n,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError);

    await expect(postingCount(pool)).resolves.toBe(before);
  });

  it('balances every denomination independently', async () => {
    const fixture = await createCashLedgerFixture(pool);
    const otherPartyId = randomUUID();
    await pool.query('INSERT INTO party (id, external_id) VALUES ($1, $2)', [
      otherPartyId,
      `eur-${otherPartyId}`,
    ]);
    const euroAccount = await fixture.ledger.openAccount({
      ownerId: otherPartyId,
      accountType: 'CASH',
      currency: 'EUR',
      purpose: 'AVAILABLE',
      normalSide: 'CREDIT',
    });

    await expect(
      fixture.ledger.post({
        idempotencyKey: `cross-currency-${randomUUID()}`,
        correlationId: randomUUID(),
        legs: [
          {
            accountId: fixture.holderAvailable.id,
            direction: 'DEBIT',
            amount: 10n,
          },
          {
            accountId: euroAccount.id,
            direction: 'CREDIT',
            amount: 10n,
          },
        ],
      }),
    ).rejects.toThrowError('independently by denomination');
  });

  it('serializes concurrent spends with SELECT FOR UPDATE', async () => {
    const fixture = await createCashLedgerFixture(pool, 100n);
    const firstRecipient = await createCashAccount(pool, fixture.ledger, 'first');
    const secondRecipient = await createCashAccount(pool, fixture.ledger, 'second');

    const results = await Promise.allSettled([
      fixture.ledger.post({
        idempotencyKey: `race-a-${randomUUID()}`,
        correlationId: randomUUID(),
        legs: [
          {
            accountId: fixture.holderAvailable.id,
            direction: 'CREDIT',
            amount: 80n,
          },
          {
            accountId: firstRecipient.id,
            direction: 'DEBIT',
            amount: 80n,
          },
        ],
      }),
      fixture.ledger.post({
        idempotencyKey: `race-b-${randomUUID()}`,
        correlationId: randomUUID(),
        legs: [
          {
            accountId: fixture.holderAvailable.id,
            direction: 'CREDIT',
            amount: 80n,
          },
          {
            accountId: secondRecipient.id,
            direction: 'DEBIT',
            amount: 80n,
          },
        ],
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.any(InsufficientBalanceError),
    });
    await expect(fixture.ledger.balanceOf(fixture.holderAvailable.id)).resolves.toBe(20n);
  });

  it('returns one posting for 1000 repetitions of an idempotency key', async () => {
    const fixture = await createCashLedgerFixture(pool);
    const input = {
      idempotencyKey: `repeat-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        {
          accountId: fixture.holderAvailable.id,
          direction: 'CREDIT' as const,
          amount: 10n,
        },
        {
          accountId: fixture.holderReserved.id,
          direction: 'DEBIT' as const,
          amount: 10n,
        },
      ] as const,
    };

    const results = await Promise.all(
      Array.from({ length: 1_000 }, async () => fixture.ledger.post(input)),
    );

    expect(new Set(results.map((posting) => posting.id))).toHaveLength(1);
    expect(results.every((posting) => posting.createdAt === results[0]?.createdAt)).toBe(true);

    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_postings WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    expect(BigInt(count.rows[0]?.count ?? '-1')).toBe(1n);
  }, 60_000);

  it('rejects reuse of an idempotency key with different legs', async () => {
    const fixture = await createCashLedgerFixture(pool);
    const idempotencyKey = `conflict-${randomUUID()}`;

    await fixture.ledger.reserve({
      idempotencyKey,
      correlationId: randomUUID(),
      availableAccountId: fixture.holderAvailable.id,
      reservedAccountId: fixture.holderReserved.id,
      amount: 10n,
    });

    await expect(
      fixture.ledger.reserve({
        idempotencyKey,
        correlationId: randomUUID(),
        availableAccountId: fixture.holderAvailable.id,
        reservedAccountId: fixture.holderReserved.id,
        amount: 11n,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('keeps postings immutable and corrects them only with one reversal', async () => {
    const fixture = await createCashLedgerFixture(pool, 100n);

    await expect(
      pool.query('UPDATE ledger_entries SET amount = amount + 1 WHERE posting_id = $1', [
        fixture.fundingPosting.id,
      ]),
    ).rejects.toThrowError(/append-only/u);

    await expect(
      pool.query('DELETE FROM ledger_postings WHERE id = $1', [fixture.fundingPosting.id]),
    ).rejects.toThrowError(/append-only/u);

    const reversal = await fixture.ledger.reverse({
      postingId: fixture.fundingPosting.id,
      idempotencyKey: `reverse-${randomUUID()}`,
      correlationId: randomUUID(),
    });

    expect(reversal.reversalOf).toBe(fixture.fundingPosting.id);
    await expect(fixture.ledger.balanceOf(fixture.holderAvailable.id)).resolves.toBe(0n);
    await expect(fixture.ledger.balanceOf(fixture.issuerResidual.id)).resolves.toBe(0n);

    await expect(
      fixture.ledger.reverse({
        postingId: fixture.fundingPosting.id,
        idempotencyKey: `reverse-again-${randomUUID()}`,
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PostingAlreadyReversedError);
  });

  it('never reserves more than AVAILABLE and releases by a compensating transfer', async () => {
    const fixture = await createCashLedgerFixture(pool, 50n);

    await expect(
      fixture.ledger.reserve({
        idempotencyKey: `too-much-${randomUUID()}`,
        correlationId: randomUUID(),
        availableAccountId: fixture.holderAvailable.id,
        reservedAccountId: fixture.holderReserved.id,
        amount: 51n,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    await fixture.ledger.reserve({
      idempotencyKey: `reserve-${randomUUID()}`,
      correlationId: randomUUID(),
      availableAccountId: fixture.holderAvailable.id,
      reservedAccountId: fixture.holderReserved.id,
      amount: 30n,
    });
    await fixture.ledger.release({
      idempotencyKey: `release-${randomUUID()}`,
      correlationId: randomUUID(),
      availableAccountId: fixture.holderAvailable.id,
      reservedAccountId: fixture.holderReserved.id,
      amount: 10n,
    });

    await expect(fixture.ledger.balanceOf(fixture.holderAvailable.id)).resolves.toBe(30n);
    await expect(fixture.ledger.balanceOf(fixture.holderReserved.id)).resolves.toBe(20n);
    await expect(fixture.ledger.trialBalance()).resolves.toMatchObject({ balanced: true });
  });
});

async function createCashAccount(
  pool: Pool,
  ledger: PostgresLedger,
  label: string,
): Promise<Extract<LedgerAccount, { accountType: 'CASH' }>> {
  const partyId = randomUUID();
  await pool.query('INSERT INTO party (id, external_id) VALUES ($1, $2)', [
    partyId,
    `${label}-${partyId}`,
  ]);
  return ledger.openAccount({
    ownerId: partyId,
    accountType: 'CASH',
    currency: 'USD',
    purpose: 'AVAILABLE',
    normalSide: 'DEBIT',
  });
}

async function postingCount(pool: Pool): Promise<bigint> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ledger_postings',
  );
  return BigInt(result.rows[0]?.count ?? '-1');
}

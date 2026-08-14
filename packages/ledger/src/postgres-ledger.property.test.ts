import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { InsufficientBalanceError } from './errors.js';
import { createCashLedgerFixture, createTestPool, resetLedgerDatabase } from './test-database.js';

interface BalanceOperation {
  readonly kind: 'RESERVE' | 'RELEASE';
  readonly amount: bigint;
}

const databaseAvailable = process.env.TEST_DATABASE_URL !== undefined;
const describeDatabase = databaseAvailable ? describe : describe.skip;
const operationArbitrary: fc.Arbitrary<BalanceOperation> = fc.record({
  kind: fc.constantFrom('RESERVE' as const, 'RELEASE' as const),
  amount: fc.bigInt({ min: 1n, max: 125n }),
});

describeDatabase('PostgresLedger properties', () => {
  const pool: Pool = createTestPool();

  afterAll(async () => {
    await pool.end();
  });

  it('keeps trial balance at zero and never over-reserves AVAILABLE', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArbitrary, { minLength: 1, maxLength: 25 }),
        async (operations) => {
          await resetLedgerDatabase(pool);
          const fixture = await createCashLedgerFixture(pool, 100n);
          const runId = randomUUID();
          let available = 100n;
          let reserved = 0n;

          for (const [index, operation] of operations.entries()) {
            const command = {
              idempotencyKey: `${operation.kind.toLowerCase()}-${runId}-${index}`,
              correlationId: randomUUID(),
              availableAccountId: fixture.holderAvailable.id,
              reservedAccountId: fixture.holderReserved.id,
              amount: operation.amount,
            };

            if (operation.kind === 'RESERVE') {
              if (operation.amount <= available) {
                await fixture.ledger.reserve(command);
                available -= operation.amount;
                reserved += operation.amount;
              } else {
                await expect(fixture.ledger.reserve(command)).rejects.toBeInstanceOf(
                  InsufficientBalanceError,
                );
              }
            } else if (operation.amount <= reserved) {
              await fixture.ledger.release(command);
              available += operation.amount;
              reserved -= operation.amount;
            } else {
              await expect(fixture.ledger.release(command)).rejects.toBeInstanceOf(
                InsufficientBalanceError,
              );
            }

            await expect(fixture.ledger.balanceOf(fixture.holderAvailable.id)).resolves.toBe(
              available,
            );
            await expect(fixture.ledger.balanceOf(fixture.holderReserved.id)).resolves.toBe(
              reserved,
            );

            const trialBalance = await fixture.ledger.trialBalance({
              accountType: 'CASH',
              currency: 'USD',
            });
            expect(trialBalance.balanced).toBe(true);
            expect(trialBalance.lines.every((line) => line.difference === 0n)).toBe(true);
          }
        },
      ),
      {
        numRuns: 30,
      },
    );
  }, 120_000);
});

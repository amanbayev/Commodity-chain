import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { PostgresLedger } from './postgres-ledger.js';
import type { LedgerAccount, Posting } from './types.js';

export interface CashLedgerFixture {
  readonly ledger: PostgresLedger;
  readonly holderAvailable: Extract<LedgerAccount, { accountType: 'CASH' }>;
  readonly holderReserved: Extract<LedgerAccount, { accountType: 'CASH' }>;
  readonly issuerResidual: Extract<LedgerAccount, { accountType: 'CASH' }>;
  readonly fundingPosting: Posting;
}

export function createTestPool(): Pool {
  return new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      'postgresql://postgres:postgres@127.0.0.1:5432/commodity_chain_test?sslmode=disable',
    max: 30,
  });
}

export async function resetLedgerDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE ledger_entries, ledger_postings, ledger_accounts, wallet_account, party CASCADE',
  );
}

export async function createCashLedgerFixture(
  pool: Pool,
  openingBalance = 1_000n,
): Promise<CashLedgerFixture> {
  const ledger = new PostgresLedger(pool);
  const holderId = randomUUID();
  const issuerId = randomUUID();

  await pool.query(
    `
      INSERT INTO party (id, external_id)
      VALUES ($1, $2), ($3, $4)
    `,
    [holderId, `holder-${holderId}`, issuerId, `issuer-${issuerId}`],
  );

  const holderAvailable = await ledger.openAccount({
    ownerId: holderId,
    accountType: 'CASH',
    currency: 'USD',
    purpose: 'AVAILABLE',
    normalSide: 'DEBIT',
  });
  const holderReserved = await ledger.openAccount({
    ownerId: holderId,
    accountType: 'CASH',
    currency: 'USD',
    purpose: 'RESERVED',
    normalSide: 'DEBIT',
  });
  const issuerResidual = await ledger.openAccount({
    ownerId: issuerId,
    accountType: 'CASH',
    currency: 'USD',
    purpose: 'RESIDUAL',
    normalSide: 'CREDIT',
  });

  const fundingPosting = await ledger.post({
    idempotencyKey: `fund-${randomUUID()}`,
    correlationId: randomUUID(),
    legs: [
      {
        accountId: holderAvailable.id,
        direction: 'DEBIT',
        amount: openingBalance,
      },
      {
        accountId: issuerResidual.id,
        direction: 'CREDIT',
        amount: openingBalance,
      },
    ],
  });

  return {
    ledger,
    holderAvailable,
    holderReserved,
    issuerResidual,
    fundingPosting,
  };
}

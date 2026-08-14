import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import {
  AccountPairMismatchError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  LedgerAccountNotFoundError,
  LedgerValidationError,
  PostingAlreadyReversedError,
  PostingNotFoundError,
} from './errors.js';
import {
  assertBigIntAmount,
  assertIdempotencyKey,
  assertMetadata,
  assertPostInput,
  assertUuid,
  postingRequestHash,
  serializeMetadata,
} from './guards.js';
import type {
  EntryDirection,
  CashLedgerAccount,
  CashOpenAccountInput,
  LedgerAccount,
  LedgerAccountId,
  LedgerAccountPurpose,
  LedgerAccountType,
  LedgerEntry,
  LedgerLegInput,
  LedgerPostingWriter,
  NormalSide,
  OpenAccountInput,
  PostInput,
  Posting,
  PostingId,
  ReserveInput,
  ReverseInput,
  TrialBalance,
  TrialBalanceFilter,
  TrialBalanceLine,
  TokenLedgerAccount,
  TokenOpenAccountInput,
  TransactionalLedger,
} from './types.js';

interface AccountRow extends QueryResultRow {
  id: string;
  owner_party_id: string;
  wallet_account_id: string | null;
  account_type: LedgerAccountType;
  normal_side: NormalSide;
  currency: string | null;
  instrument_id: string | null;
  purpose: LedgerAccountPurpose;
  balance: string;
  opened_at: Date | string;
}

interface PostingRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  reversal_of: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

interface EntryRow extends QueryResultRow {
  account_id: string;
  direction: EntryDirection;
  amount: string;
}

interface TrialBalanceRow extends QueryResultRow {
  account_type: LedgerAccountType;
  currency: string | null;
  instrument_id: string | null;
  debits: string;
  credits: string;
}

type Queryable = Pool | PoolClient;

export interface LedgerPostingHooks {
  afterEntryInserted?(legIndex: number): void | Promise<void>;
}

const ACCOUNT_SELECT = `
  SELECT
    id,
    owner_party_id,
    wallet_account_id,
    account_type,
    normal_side,
    currency,
    instrument_id,
    purpose,
    balance::text,
    opened_at
  FROM ledger_accounts
`;

export class PostgresLedger implements TransactionalLedger {
  public constructor(
    private readonly pool: Pool,
    private readonly hooks: LedgerPostingHooks = {},
  ) {}

  public openAccount(input: CashOpenAccountInput): Promise<CashLedgerAccount>;
  public openAccount(input: TokenOpenAccountInput): Promise<TokenLedgerAccount>;
  public async openAccount(input: OpenAccountInput): Promise<LedgerAccount> {
    validateOpenAccountInput(input);

    const id = randomUUID();
    const result = await this.pool.query<AccountRow>(
      `
        INSERT INTO ledger_accounts (
          id,
          owner_party_id,
          wallet_account_id,
          account_type,
          normal_side,
          currency,
          instrument_id,
          purpose
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          id,
          owner_party_id,
          wallet_account_id,
          account_type,
          normal_side,
          currency,
          instrument_id,
          purpose,
          balance::text,
          opened_at
      `,
      [
        id,
        input.ownerId,
        input.walletAccountId ?? null,
        input.accountType,
        input.normalSide,
        input.accountType === 'CASH' ? input.currency : null,
        input.accountType === 'TOKEN' ? input.instrumentId : null,
        input.purpose,
      ],
    );

    return mapAccount(requireFirstRow(result, 'Created ledger account was not returned'));
  }

  public async post(input: PostInput): Promise<Posting> {
    return this.postInternal(input, null);
  }

  public withinTransaction(transaction: PoolClient): LedgerPostingWriter {
    return {
      post: (input: PostInput): Promise<Posting> => this.postWithClient(transaction, input, null),
      reserve: async (input: ReserveInput): Promise<Posting> => {
        await this.validateMovementAccounts(input, 'AVAILABLE', 'RESERVED', transaction);
        return this.postWithClient(transaction, movementPosting(input, 'RESERVE'), null);
      },
      release: async (input: ReserveInput): Promise<Posting> => {
        await this.validateMovementAccounts(input, 'AVAILABLE', 'RESERVED', transaction);
        return this.postWithClient(transaction, movementPosting(input, 'RELEASE'), null);
      },
    };
  }

  public async reserve(input: ReserveInput): Promise<Posting> {
    await this.validateMovementAccounts(input, 'AVAILABLE', 'RESERVED');

    return this.post({
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      legs: [
        {
          accountId: input.availableAccountId,
          direction: 'CREDIT',
          amount: input.amount,
        },
        {
          accountId: input.reservedAccountId,
          direction: 'DEBIT',
          amount: input.amount,
        },
      ],
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  public async release(input: ReserveInput): Promise<Posting> {
    await this.validateMovementAccounts(input, 'AVAILABLE', 'RESERVED');

    return this.post({
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      legs: [
        {
          accountId: input.availableAccountId,
          direction: 'DEBIT',
          amount: input.amount,
        },
        {
          accountId: input.reservedAccountId,
          direction: 'CREDIT',
          amount: input.amount,
        },
      ],
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  public async reverse(input: ReverseInput): Promise<Posting> {
    assertUuid(input.postingId, 'postingId');
    assertIdempotencyKey(input.idempotencyKey);
    assertUuid(input.correlationId, 'correlationId');

    if (input.metadata !== undefined) {
      assertMetadata(input.metadata);
    }

    const original = await this.readPosting(this.pool, input.postingId);
    if (original === null) {
      throw new PostingNotFoundError(input.postingId);
    }

    const inverseLegs = original.legs.map<LedgerLegInput>((leg) => ({
      accountId: leg.accountId,
      direction: leg.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amount: leg.amount,
    }));

    if (inverseLegs.length < 2) {
      throw new LedgerValidationError('Original posting does not contain at least two legs');
    }

    return this.postInternal(
      {
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        legs: [inverseLegs[0]!, inverseLegs[1]!, ...inverseLegs.slice(2)],
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
      input.postingId,
    );
  }

  public async balanceOf(accountId: LedgerAccountId): Promise<bigint> {
    assertUuid(accountId, 'accountId');

    const result = await this.pool.query<{ balance: string } & QueryResultRow>(
      'SELECT balance::text FROM ledger_accounts WHERE id = $1',
      [accountId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new LedgerAccountNotFoundError([accountId]);
    }

    return BigInt(row.balance);
  }

  public async trialBalance(filter: TrialBalanceFilter = {}): Promise<TrialBalance> {
    validateTrialBalanceFilter(filter);

    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.accountType !== undefined) {
      values.push(filter.accountType);
      clauses.push(`account.account_type = $${values.length}`);
    }

    if (filter.currency !== undefined) {
      values.push(filter.currency);
      clauses.push(`account.currency = $${values.length}`);
    }

    if (filter.instrumentId !== undefined) {
      values.push(filter.instrumentId);
      clauses.push(`account.instrument_id = $${values.length}`);
    }

    const whereClause = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const result = await this.pool.query<TrialBalanceRow>(
      `
        SELECT
          account.account_type,
          account.currency,
          account.instrument_id,
          coalesce(
            sum(entry.amount) FILTER (WHERE entry.direction = 'DEBIT'),
            0
          )::text AS debits,
          coalesce(
            sum(entry.amount) FILTER (WHERE entry.direction = 'CREDIT'),
            0
          )::text AS credits
        FROM ledger_entries AS entry
        JOIN ledger_accounts AS account ON account.id = entry.account_id
        ${whereClause}
        GROUP BY account.account_type, account.currency, account.instrument_id
        ORDER BY account.account_type, account.currency, account.instrument_id
      `,
      values,
    );

    const lines = result.rows.map(mapTrialBalanceLine);

    return {
      lines,
      balanced: lines.every((line) => line.difference === 0n),
    };
  }

  private async postInternal(input: PostInput, reversalOf: PostingId | null): Promise<Posting> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const posting = await this.postWithClient(client, input, reversalOf);
      await client.query('COMMIT');
      return posting;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async postWithClient(
    client: PoolClient,
    input: PostInput,
    reversalOf: PostingId | null,
  ): Promise<Posting> {
    assertPostInput(input);
    const requestHash = postingRequestHash(input.legs, reversalOf, input.metadata);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      input.idempotencyKey,
    ]);

    const existingResult = await client.query<PostingRow>(
      `
        SELECT
          id,
          idempotency_key,
          request_hash,
          reversal_of,
          correlation_id,
          metadata,
          created_at
        FROM ledger_postings
        WHERE idempotency_key = $1
      `,
      [input.idempotencyKey],
    );
    const existing = existingResult.rows[0];

    if (existing !== undefined) {
      if (!existing.request_hash.equals(requestHash)) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return this.loadPosting(client, existing);
    }

    if (reversalOf !== null) {
      const originalResult = await client.query<{ id: string } & QueryResultRow>(
        'SELECT id FROM ledger_postings WHERE id = $1 FOR SHARE',
        [reversalOf],
      );
      if (originalResult.rowCount === 0) {
        throw new PostingNotFoundError(reversalOf);
      }

      const priorReversal = await client.query<{ id: string } & QueryResultRow>(
        'SELECT id FROM ledger_postings WHERE reversal_of = $1',
        [reversalOf],
      );
      if (priorReversal.rowCount !== 0) {
        throw new PostingAlreadyReversedError(reversalOf);
      }
    }

    const uniqueAccountIds = [...new Set(input.legs.map((leg) => leg.accountId))].sort();
    const accountResult = await client.query<AccountRow>(
      `
        ${ACCOUNT_SELECT}
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE
      `,
      [uniqueAccountIds],
    );

    if (accountResult.rows.length !== uniqueAccountIds.length) {
      const found = new Set(accountResult.rows.map((row) => row.id));
      const missing = uniqueAccountIds.filter((id) => !found.has(id));
      throw new LedgerAccountNotFoundError(missing);
    }

    const accounts = new Map(accountResult.rows.map((row) => [row.id, row] as const));
    const denominationTotals = new Map<string, bigint>();
    const balanceDeltas = new Map<string, bigint>();

    for (const leg of input.legs) {
      const account = accounts.get(leg.accountId);
      if (account === undefined) {
        throw new LedgerAccountNotFoundError([leg.accountId]);
      }

      const denomination = denominationKey(account);
      const signedPostingAmount = leg.direction === 'DEBIT' ? leg.amount : -leg.amount;
      denominationTotals.set(
        denomination,
        (denominationTotals.get(denomination) ?? 0n) + signedPostingAmount,
      );

      const balanceDelta = leg.direction === account.normal_side ? leg.amount : -leg.amount;
      balanceDeltas.set(account.id, (balanceDeltas.get(account.id) ?? 0n) + balanceDelta);
    }

    if ([...denominationTotals.values()].some((total) => total !== 0n)) {
      throw new LedgerValidationError('Posting must balance independently by denomination');
    }

    const resultingBalances = new Map<string, bigint>();
    for (const [accountId, delta] of balanceDeltas) {
      const account = accounts.get(accountId);
      if (account === undefined) {
        throw new LedgerAccountNotFoundError([asAccountId(accountId)]);
      }

      const currentBalance = BigInt(account.balance);
      const resultingBalance = currentBalance + delta;
      if (resultingBalance < 0n) {
        throw new InsufficientBalanceError(
          asAccountId(accountId),
          currentBalance,
          delta < 0n ? -delta : delta,
        );
      }
      resultingBalances.set(accountId, resultingBalance);
    }

    const postingId = randomUUID();
    const postingResult = await client.query<PostingRow>(
      `
        INSERT INTO ledger_postings (
          id,
          idempotency_key,
          request_hash,
          reversal_of,
          correlation_id,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING
          id,
          idempotency_key,
          request_hash,
          reversal_of,
          correlation_id,
          metadata,
          created_at
      `,
      [
        postingId,
        input.idempotencyKey,
        requestHash,
        reversalOf,
        input.correlationId,
        serializeMetadata(input.metadata),
      ],
    );

    for (const [index, leg] of input.legs.entries()) {
      await client.query(
        `
          INSERT INTO ledger_entries (
            id,
            posting_id,
            leg_index,
            account_id,
            direction,
            amount
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [randomUUID(), postingId, index, leg.accountId, leg.direction, leg.amount.toString()],
      );
      await this.hooks.afterEntryInserted?.(index);
    }

    for (const [accountId, balance] of resultingBalances) {
      await client.query('UPDATE ledger_accounts SET balance = $2 WHERE id = $1', [
        accountId,
        balance.toString(),
      ]);
    }

    return this.loadPosting(
      client,
      requireFirstRow(postingResult, 'Created ledger posting was not returned'),
    );
  }

  private async validateMovementAccounts(
    input: ReserveInput,
    availablePurpose: LedgerAccountPurpose,
    reservedPurpose: LedgerAccountPurpose,
    executor: Queryable = this.pool,
  ): Promise<void> {
    assertIdempotencyKey(input.idempotencyKey);
    assertUuid(input.correlationId, 'correlationId');
    assertUuid(input.availableAccountId, 'availableAccountId');
    assertUuid(input.reservedAccountId, 'reservedAccountId');
    assertBigIntAmount(input.amount, 'amount');

    if (input.metadata !== undefined) {
      assertMetadata(input.metadata);
    }

    const result = await query<AccountRow>(
      executor,
      `
        ${ACCOUNT_SELECT}
        WHERE id = ANY($1::uuid[])
        ORDER BY id
      `,
      [[input.availableAccountId, input.reservedAccountId]],
    );

    if (result.rows.length !== 2) {
      const found = new Set(result.rows.map((row) => row.id));
      const missing = [input.availableAccountId, input.reservedAccountId].filter(
        (id) => !found.has(id),
      );
      throw new LedgerAccountNotFoundError(missing);
    }

    const accounts = new Map(result.rows.map((row) => [row.id, row] as const));
    const available = accounts.get(input.availableAccountId);
    const reserved = accounts.get(input.reservedAccountId);

    if (available === undefined || reserved === undefined) {
      throw new LedgerAccountNotFoundError([input.availableAccountId, input.reservedAccountId]);
    }

    if (
      available.purpose !== availablePurpose ||
      reserved.purpose !== reservedPurpose ||
      available.owner_party_id !== reserved.owner_party_id ||
      available.account_type !== reserved.account_type ||
      available.normal_side !== reserved.normal_side ||
      denominationKey(available) !== denominationKey(reserved)
    ) {
      throw new AccountPairMismatchError(
        'Reserve and release require matching AVAILABLE and RESERVED accounts',
      );
    }
  }

  private async readPosting(executor: Queryable, postingId: PostingId): Promise<Posting | null> {
    const result = await query<PostingRow>(
      executor,
      `
        SELECT
          id,
          idempotency_key,
          request_hash,
          reversal_of,
          correlation_id,
          metadata,
          created_at
        FROM ledger_postings
        WHERE id = $1
      `,
      [postingId],
    );
    const row = result.rows[0];

    return row === undefined ? null : this.loadPosting(executor, row);
  }

  private async loadPosting(executor: Queryable, row: PostingRow): Promise<Posting> {
    const entriesResult = await query<EntryRow>(
      executor,
      `
        SELECT account_id, direction, amount::text
        FROM ledger_entries
        WHERE posting_id = $1
        ORDER BY leg_index
      `,
      [row.id],
    );

    const legs = entriesResult.rows.map<LedgerEntry>((entry) => ({
      accountId: asAccountId(entry.account_id),
      direction: entry.direction,
      amount: BigInt(entry.amount),
    }));

    return {
      id: asPostingId(row.id),
      idempotencyKey: row.idempotency_key,
      ...(row.reversal_of === null ? {} : { reversalOf: asPostingId(row.reversal_of) }),
      correlationId: row.correlation_id,
      legs,
      metadata: row.metadata,
      createdAt: toIsoString(row.created_at),
    };
  }
}

export function createPostgresLedger(pool: Pool): TransactionalLedger {
  return new PostgresLedger(pool);
}

function validateOpenAccountInput(input: OpenAccountInput): void {
  if (input === null || typeof input !== 'object') {
    throw new LedgerValidationError('Open-account input must be an object');
  }

  assertUuid(input.ownerId, 'ownerId');
  if (input.walletAccountId !== undefined) {
    assertUuid(input.walletAccountId, 'walletAccountId');
  }

  if (!['AVAILABLE', 'RESERVED', 'FEE', 'RESIDUAL'].includes(input.purpose)) {
    throw new LedgerValidationError('purpose is invalid');
  }
  if (input.normalSide !== 'DEBIT' && input.normalSide !== 'CREDIT') {
    throw new LedgerValidationError('normalSide is invalid');
  }

  if (input.accountType === 'CASH') {
    if (!/^[A-Z]{3}$/u.test(input.currency)) {
      throw new LedgerValidationError('currency must be a three-letter uppercase code');
    }
  } else if (input.accountType === 'TOKEN') {
    assertUuid(input.instrumentId, 'instrumentId');
  } else {
    throw new LedgerValidationError('accountType is invalid');
  }
}

function validateTrialBalanceFilter(filter: TrialBalanceFilter): void {
  if (
    filter.accountType !== undefined &&
    filter.accountType !== 'CASH' &&
    filter.accountType !== 'TOKEN'
  ) {
    throw new LedgerValidationError('accountType filter is invalid');
  }
  if (filter.currency !== undefined && !/^[A-Z]{3}$/u.test(filter.currency)) {
    throw new LedgerValidationError('currency filter is invalid');
  }
  if (filter.instrumentId !== undefined) {
    assertUuid(filter.instrumentId, 'instrumentId');
  }
}

function movementPosting(input: ReserveInput, kind: 'RESERVE' | 'RELEASE'): PostInput {
  const reserve = kind === 'RESERVE';
  return {
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    legs: [
      {
        accountId: input.availableAccountId,
        direction: reserve ? 'CREDIT' : 'DEBIT',
        amount: input.amount,
      },
      {
        accountId: input.reservedAccountId,
        direction: reserve ? 'DEBIT' : 'CREDIT',
        amount: input.amount,
      },
    ],
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

function denominationKey(account: AccountRow): string {
  if (account.account_type === 'CASH' && account.currency !== null) {
    return `CASH:${account.currency}`;
  }
  if (account.account_type === 'TOKEN' && account.instrument_id !== null) {
    return `TOKEN:${account.instrument_id}`;
  }

  throw new LedgerValidationError(`Ledger account ${account.id} has an invalid denomination`);
}

function mapAccount(row: AccountRow): LedgerAccount {
  const common = {
    id: asAccountId(row.id),
    ownerId: row.owner_party_id,
    ...(row.wallet_account_id === null ? {} : { walletAccountId: row.wallet_account_id }),
    purpose: row.purpose,
    normalSide: row.normal_side,
    balance: BigInt(row.balance),
    openedAt: toIsoString(row.opened_at),
  };

  if (row.account_type === 'CASH' && row.currency !== null) {
    return {
      ...common,
      accountType: 'CASH',
      currency: row.currency,
    };
  }
  if (row.account_type === 'TOKEN' && row.instrument_id !== null) {
    return {
      ...common,
      accountType: 'TOKEN',
      instrumentId: row.instrument_id,
    };
  }

  throw new LedgerValidationError(`Ledger account ${row.id} has an invalid denomination`);
}

function mapTrialBalanceLine(row: TrialBalanceRow): TrialBalanceLine {
  const debits = BigInt(row.debits);
  const credits = BigInt(row.credits);
  const totals = {
    debits,
    credits,
    difference: debits - credits,
  };

  if (row.account_type === 'CASH' && row.currency !== null) {
    return {
      accountType: 'CASH',
      currency: row.currency,
      ...totals,
    };
  }
  if (row.account_type === 'TOKEN' && row.instrument_id !== null) {
    return {
      accountType: 'TOKEN',
      instrumentId: row.instrument_id,
      ...totals,
    };
  }

  throw new LedgerValidationError('Trial balance contains an invalid denomination');
}

async function query<Row extends QueryResultRow>(
  executor: Queryable,
  text: string,
  values: unknown[],
): Promise<QueryResult<Row>> {
  return executor.query<Row>(text, values);
}

function requireFirstRow<Row extends QueryResultRow>(
  result: QueryResult<Row>,
  message: string,
): Row {
  const row = result.rows[0];
  if (row === undefined) {
    throw new LedgerErrorForImpossibleState(message);
  }
  return row;
}

class LedgerErrorForImpossibleState extends Error {}

function asAccountId(value: string): LedgerAccountId {
  return value as LedgerAccountId;
}

function asPostingId(value: string): PostingId {
  return value as PostingId;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

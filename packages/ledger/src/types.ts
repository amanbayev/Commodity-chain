import type { Pool, PoolClient } from 'pg';

declare const ledgerAccountIdBrand: unique symbol;
declare const postingIdBrand: unique symbol;

export type LedgerAccountId = string & {
  readonly [ledgerAccountIdBrand]: true;
};

export type PostingId = string & {
  readonly [postingIdBrand]: true;
};

export type LedgerAccountType = 'CASH' | 'TOKEN';
export type LedgerAccountPurpose = 'AVAILABLE' | 'RESERVED' | 'FEE' | 'RESIDUAL';
export type NormalSide = 'DEBIT' | 'CREDIT';
export type EntryDirection = 'DEBIT' | 'CREDIT';
export type LedgerMetadata = Readonly<Record<string, unknown>>;

interface OpenAccountBase {
  readonly ownerId: string;
  readonly walletAccountId?: string;
  readonly purpose: LedgerAccountPurpose;
  readonly normalSide: NormalSide;
}

export type CashOpenAccountInput = OpenAccountBase & {
  readonly accountType: 'CASH';
  readonly currency: string;
  readonly instrumentId?: never;
};

export type TokenOpenAccountInput = OpenAccountBase & {
  readonly accountType: 'TOKEN';
  readonly instrumentId: string;
  readonly currency?: never;
};

export type OpenAccountInput = CashOpenAccountInput | TokenOpenAccountInput;

interface LedgerAccountBase {
  readonly id: LedgerAccountId;
  readonly ownerId: string;
  readonly walletAccountId?: string;
  readonly purpose: LedgerAccountPurpose;
  readonly normalSide: NormalSide;
  readonly balance: bigint;
  readonly openedAt: string;
}

export type CashLedgerAccount = LedgerAccountBase & {
  readonly accountType: 'CASH';
  readonly currency: string;
  readonly instrumentId?: never;
};

export type TokenLedgerAccount = LedgerAccountBase & {
  readonly accountType: 'TOKEN';
  readonly instrumentId: string;
  readonly currency?: never;
};

export type LedgerAccount = CashLedgerAccount | TokenLedgerAccount;

export interface LedgerLegInput {
  readonly accountId: LedgerAccountId;
  readonly direction: EntryDirection;
  readonly amount: bigint;
}

export type LedgerLegTuple = readonly [LedgerLegInput, LedgerLegInput, ...LedgerLegInput[]];

export interface PostInput {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly legs: LedgerLegTuple;
  readonly metadata?: LedgerMetadata;
}

export interface ReserveInput {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly availableAccountId: LedgerAccountId;
  readonly reservedAccountId: LedgerAccountId;
  readonly amount: bigint;
  readonly metadata?: LedgerMetadata;
}

export interface ReverseInput {
  readonly postingId: PostingId;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly metadata?: LedgerMetadata;
}

export interface LedgerEntry {
  readonly accountId: LedgerAccountId;
  readonly direction: EntryDirection;
  readonly amount: bigint;
}

export interface Posting {
  readonly id: PostingId;
  readonly idempotencyKey: string;
  readonly reversalOf?: PostingId;
  readonly correlationId: string;
  readonly legs: readonly LedgerEntry[];
  readonly metadata: LedgerMetadata;
  readonly createdAt: string;
}

export interface TrialBalanceFilter {
  readonly accountType?: LedgerAccountType;
  readonly currency?: string;
  readonly instrumentId?: string;
}

interface TrialBalanceLineBase {
  readonly debits: bigint;
  readonly credits: bigint;
  readonly difference: bigint;
}

export type TrialBalanceLine =
  | (TrialBalanceLineBase & {
      readonly accountType: 'CASH';
      readonly currency: string;
      readonly instrumentId?: never;
    })
  | (TrialBalanceLineBase & {
      readonly accountType: 'TOKEN';
      readonly instrumentId: string;
      readonly currency?: never;
    });

export interface TrialBalance {
  readonly lines: readonly TrialBalanceLine[];
  readonly balanced: boolean;
}

export interface Ledger {
  openAccount(input: CashOpenAccountInput): Promise<CashLedgerAccount>;
  openAccount(input: TokenOpenAccountInput): Promise<TokenLedgerAccount>;
  post(input: PostInput): Promise<Posting>;
  reserve(input: ReserveInput): Promise<Posting>;
  release(input: ReserveInput): Promise<Posting>;
  reverse(input: ReverseInput): Promise<Posting>;
  balanceOf(accountId: LedgerAccountId): Promise<bigint>;
  trialBalance(filter?: TrialBalanceFilter): Promise<TrialBalance>;
}

export interface LedgerPostingWriter {
  post(input: PostInput): Promise<Posting>;
}

export interface TransactionalLedger extends Ledger {
  withinTransaction(transaction: LedgerTransaction): LedgerPostingWriter;
}

export type LedgerPool = Pool;
export type LedgerTransaction = PoolClient;

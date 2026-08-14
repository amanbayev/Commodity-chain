export const FINALITY_STATUSES = [
  'CREATED',
  'FUNDED',
  'SUBMITTED',
  'TECHNICALLY_CONFIRMED',
  'LEGALLY_FINAL',
  'RECONCILED',
  'PENDING_RECONCILIATION',
  'FAILED_BEFORE_FINALITY',
  'MANUAL_REPAIR',
] as const;

export type FinalityStatus = (typeof FINALITY_STATUSES)[number];

export interface SettlementCreatedDomainEvent {
  readonly eventId: string;
  readonly nonce: string;
  readonly eventType: 'SETTLEMENT_CREATED';
  readonly schemaVersion: '1';
  readonly occurredAt: string;
  readonly tradeId: string;
  readonly correlationId: string;
}

export interface SettlementProcessingResult {
  readonly settlementId: string;
  readonly status: FinalityStatus;
  readonly ledgerPostingId?: string;
  readonly replayed: boolean;
  readonly failureCode?: string;
}

export interface SettlementFailureHooks {
  afterLedgerPost?(): void | Promise<void>;
}

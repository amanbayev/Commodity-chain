import { SettlementError } from './settlement.errors.js';
import type { FinalityStatus } from './settlement.types.js';

const ALLOWED_TRANSITIONS: Readonly<Record<FinalityStatus, readonly FinalityStatus[]>> = {
  CREATED: ['FUNDED', 'FAILED_BEFORE_FINALITY'],
  FUNDED: ['SUBMITTED', 'FAILED_BEFORE_FINALITY'],
  SUBMITTED: ['TECHNICALLY_CONFIRMED', 'FAILED_BEFORE_FINALITY'],
  TECHNICALLY_CONFIRMED: ['LEGALLY_FINAL'],
  LEGALLY_FINAL: ['RECONCILED', 'PENDING_RECONCILIATION'],
  RECONCILED: [],
  PENDING_RECONCILIATION: ['RECONCILED', 'MANUAL_REPAIR'],
  FAILED_BEFORE_FINALITY: ['MANUAL_REPAIR'],
  MANUAL_REPAIR: [],
};

export function canTransition(from: FinalityStatus, to: FinalityStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertSettlementTransition(from: FinalityStatus, to: FinalityStatus): void {
  if (!canTransition(from, to)) {
    throw new SettlementError(
      'INVALID_SETTLEMENT_TRANSITION',
      `Settlement transition ${from} -> ${to} is not allowed`,
    );
  }
}

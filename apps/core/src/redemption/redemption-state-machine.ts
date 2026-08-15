import { RedemptionError } from './redemption.errors.js';
import type { RedemptionStatus } from './redemption.types.js';

const ALLOWED: Readonly<Record<RedemptionStatus, readonly RedemptionStatus[]>> = {
  CREATED: ['TOKENS_LOCKED', 'CANCELLED'],
  TOKENS_LOCKED: ['IN_DELIVERY', 'CANCELLED', 'EXCEPTION'],
  IN_DELIVERY: ['COMPLETED', 'EXCEPTION', 'QUARANTINED'],
  COMPLETED: [],
  CANCELLED: [],
  EXCEPTION: [],
  QUARANTINED: [],
};

export function canTransitionRedemption(from: RedemptionStatus, to: RedemptionStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertRedemptionTransition(from: RedemptionStatus, to: RedemptionStatus): void {
  if (!canTransitionRedemption(from, to)) {
    throw new RedemptionError(
      'INVALID_TRANSITION',
      `Redemption transition ${from} -> ${to} is not allowed`,
      409,
    );
  }
}

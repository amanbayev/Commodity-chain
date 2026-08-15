import { describe, expect, it } from 'vitest';

import { assertSettlementTransition, canTransition } from './settlement-state-machine.js';
import { FINALITY_STATUSES } from './settlement.types.js';

const valid = new Set([
  'CREATED:FUNDED',
  'CREATED:FAILED_BEFORE_FINALITY',
  'FUNDED:SUBMITTED',
  'FUNDED:FAILED_BEFORE_FINALITY',
  'SUBMITTED:TECHNICALLY_CONFIRMED',
  'SUBMITTED:FAILED_BEFORE_FINALITY',
  'TECHNICALLY_CONFIRMED:LEGALLY_FINAL',
  'LEGALLY_FINAL:RECONCILED',
  'LEGALLY_FINAL:PENDING_RECONCILIATION',
  'PENDING_RECONCILIATION:RECONCILED',
  'PENDING_RECONCILIATION:MANUAL_REPAIR',
  'FAILED_BEFORE_FINALITY:MANUAL_REPAIR',
]);

describe('settlement state machine', () => {
  it('accepts exactly the declared transition matrix', () => {
    for (const from of FINALITY_STATUSES) {
      for (const to of FINALITY_STATUSES) {
        const expected = valid.has(`${from}:${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) expect(() => assertSettlementTransition(from, to)).not.toThrow();
        else expect(() => assertSettlementTransition(from, to)).toThrow(/not allowed/u);
      }
    }
  });

  it('never permits a LEGALLY_FINAL settlement to return to a pre-final state', () => {
    for (const target of [
      'CREATED',
      'FUNDED',
      'SUBMITTED',
      'TECHNICALLY_CONFIRMED',
      'FAILED_BEFORE_FINALITY',
    ] as const) {
      expect(canTransition('LEGALLY_FINAL', target)).toBe(false);
    }
  });
});

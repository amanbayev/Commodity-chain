import { describe, expect, it } from 'vitest';

import {
  INSTRUMENT_STATUSES,
  InvalidInstrumentTransitionError,
  transitionInstrument,
} from './instrument-state-machine.js';
import type { InstrumentStatus } from './instrument-state-machine.js';

const forward = new Set([
  'DRAFT->UNDER_REVIEW',
  'UNDER_REVIEW->APPROVED',
  'APPROVED->COLLATERALIZED',
  'COLLATERALIZED->PRIMARY',
  'PRIMARY->ACTIVE',
  'ACTIVE->REDEMPTION',
  'REDEMPTION->MATURED',
  'REDEMPTION->CLOSED',
]);
const suspendable = new Set<InstrumentStatus>([
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'COLLATERALIZED',
  'PRIMARY',
  'ACTIVE',
  'REDEMPTION',
  'MATURED',
  'CLOSED',
  'DEFAULT',
]);

describe('instrument lifecycle state machine', () => {
  it('accepts every declared forward transition and rejects every other status pair', () => {
    for (const from of INSTRUMENT_STATUSES) {
      for (const to of INSTRUMENT_STATUSES) {
        const expected =
          forward.has(`${from}->${to}`) || (to === 'SUSPENDED' && suspendable.has(from));
        if (expected) {
          const next = transitionInstrument({ status: from, suspendedFrom: null }, to);
          expect(next.status, `${from}->${to}`).toBe(to);
          expect(next.suspendedFrom, `${from}->${to}`).toBe(to === 'SUSPENDED' ? from : null);
        } else {
          expect(
            () => transitionInstrument({ status: from, suspendedFrom: null }, to),
            `${from}->${to}`,
          ).toThrowError(InvalidInstrumentTransitionError);
        }
      }
    }
  });

  it('resumes only to the exact status saved at suspension', () => {
    for (const previous of suspendable) {
      expect(
        transitionInstrument({ status: 'SUSPENDED', suspendedFrom: previous }, previous),
      ).toEqual({ status: previous, suspendedFrom: null });
      for (const target of INSTRUMENT_STATUSES.filter((status) => status !== previous)) {
        expect(() =>
          transitionInstrument({ status: 'SUSPENDED', suspendedFrom: previous }, target),
        ).toThrowError(InvalidInstrumentTransitionError);
      }
    }
  });
});

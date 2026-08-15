import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RedemptionError } from './redemption.errors.js';
import { assertRedemptionTransition, canTransitionRedemption } from './redemption-state-machine.js';
import { validateCreateCommand } from './redemption.service.js';
import { REDEMPTION_STATUSES, type RedemptionStatus } from './redemption.types.js';

const VALID: Readonly<Record<RedemptionStatus, readonly RedemptionStatus[]>> = {
  CREATED: ['TOKENS_LOCKED', 'CANCELLED'],
  TOKENS_LOCKED: ['IN_DELIVERY', 'CANCELLED', 'EXCEPTION'],
  IN_DELIVERY: ['COMPLETED', 'EXCEPTION', 'QUARANTINED'],
  COMPLETED: [],
  CANCELLED: [],
  EXCEPTION: [],
  QUARANTINED: [],
};

describe('redemption state machine', () => {
  for (const from of REDEMPTION_STATUSES) {
    for (const to of REDEMPTION_STATUSES) {
      const expected = VALID[from].includes(to);
      it(`${expected ? 'allows' : 'rejects'} ${from} -> ${to}`, () => {
        expect(canTransitionRedemption(from, to)).toBe(expected);
        if (expected) {
          expect(() => assertRedemptionTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertRedemptionTransition(from, to)).toThrow(RedemptionError);
        }
      });
    }
  }
});

describe('redemption command validation', () => {
  it('accepts bigint quantities and physical delivery details', () => {
    expect(validateCreateCommand(command(10n))).toBeNull();
  });

  it('rejects number quantities at runtime', () => {
    const invalid = { ...command(10n), quantity: 10 as unknown as bigint };
    expect(validateCreateCommand(invalid)?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-physical methods reserved by the contract', () => {
    const invalid = {
      ...command(10n),
      method: 'CASH' as unknown as 'PHYSICAL_DELIVERY',
    };
    expect(validateCreateCommand(invalid)?.code).toBe('VALIDATION_ERROR');
  });
});

function command(quantity: bigint) {
  return {
    holderId: randomUUID(),
    instrumentId: randomUUID(),
    quantity,
    method: 'PHYSICAL_DELIVERY' as const,
    delivery: {
      elevatorId: 'elevator-1',
      requestedDate: '2026-08-20',
      recipient: 'Talgat Amanbayev',
      transport: 'Truck KZ-001',
    },
    proofs: [],
    idempotencyKey: `redemption-${randomUUID()}`,
    correlationId: randomUUID(),
  };
}

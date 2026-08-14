import { describe, expect, it } from 'vitest';

import {
  calculateBuyReservation,
  calculateFee,
  calculateRemainingBuyReservation,
} from './fee-calculator.js';

describe('OMS fee and reserve calculator', () => {
  it('reserves limit notional plus the worse of maker and taker fees', () => {
    expect(calculateBuyReservation(50n, 110n, { makerRatePpm: 500n, takerRatePpm: 1_000n })).toBe(
      5_506n,
    );
  });

  it('rounds fees upward in integer minor units', () => {
    expect(calculateFee(1n, 1n)).toBe(1n);
    expect(calculateFee(1_000n, 1_000n)).toBe(1n);
    expect(calculateFee(1_001n, 1_000n)).toBe(2n);
  });

  it('calculates partial-fill remainder cumulatively and reaches exactly zero', () => {
    const rates = { makerRatePpm: 500n, takerRatePpm: 1_000n };
    expect(calculateRemainingBuyReservation(20n, 110n, rates)).toBe(2_203n);
    expect(calculateRemainingBuyReservation(0n, 110n, rates)).toBe(0n);
  });

  it('rejects number values and NUMERIC(38,0) overflow', () => {
    expect(() =>
      calculateBuyReservation(10 as unknown as bigint, 100n, {
        makerRatePpm: 0n,
        takerRatePpm: 0n,
      }),
    ).toThrow('positive bigint');
    expect(() =>
      calculateBuyReservation(10n ** 38n - 1n, 2n, {
        makerRatePpm: 0n,
        takerRatePpm: 0n,
      }),
    ).toThrow('NUMERIC(38,0)');
  });
});

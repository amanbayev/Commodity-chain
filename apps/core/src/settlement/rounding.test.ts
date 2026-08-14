import { describe, expect, it } from 'vitest';

import { allocateCommission } from './rounding.js';

describe('settlement commission allocation', () => {
  it('truncates the fee and sends a fractional tail to one residual minor unit', () => {
    expect(allocateCommission(1_001n, 1_000n)).toEqual({ fee: 1n, residual: 1n, charged: 2n });
    expect(allocateCommission(1_000n, 1_000n)).toEqual({ fee: 1n, residual: 0n, charged: 1n });
  });

  it('uses bigint only at runtime', () => {
    expect(() => allocateCommission(1.5 as unknown as bigint, 1n)).toThrow(/bigint/u);
    expect(() => allocateCommission(1n, -1n)).toThrow(/non-negative bigint/u);
  });
});

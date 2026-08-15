const FEE_SCALE = 1_000_000n;

export interface CommissionAllocation {
  readonly fee: bigint;
  readonly residual: bigint;
  readonly charged: bigint;
}

export function allocateCommission(notional: bigint, ratePpm: bigint): CommissionAllocation {
  assertNonNegativeBigint(notional, 'notional');
  assertNonNegativeBigint(ratePpm, 'ratePpm');
  if (ratePpm > FEE_SCALE) throw new RangeError('ratePpm must not exceed 1000000');
  const numerator = notional * ratePpm;
  const fee = numerator / FEE_SCALE;
  const residual = numerator % FEE_SCALE === 0n ? 0n : 1n;
  return { fee, residual, charged: fee + residual };
}

function assertNonNegativeBigint(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${field} must be a non-negative bigint`);
  }
}

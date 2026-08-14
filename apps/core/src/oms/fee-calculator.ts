import { OmsError } from './oms.errors.js';

export const FEE_RATE_SCALE = 1_000_000n;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;

export interface FeeRates {
  readonly makerRatePpm: bigint;
  readonly takerRatePpm: bigint;
}

export function calculateFee(notional: bigint, ratePpm: bigint): bigint {
  assertNonNegative(notional, 'notional');
  assertRate(ratePpm);
  if (notional === 0n || ratePpm === 0n) return 0n;
  return assertNumeric38((notional * ratePpm + FEE_RATE_SCALE - 1n) / FEE_RATE_SCALE, 'fee');
}

export function calculateBuyReservation(
  quantity: bigint,
  limitPrice: bigint,
  rates: FeeRates,
): bigint {
  assertPositive(quantity, 'quantity');
  assertPositive(limitPrice, 'limitPrice');
  const notional = assertNumeric38(quantity * limitPrice, 'notional');
  const worstRate =
    rates.makerRatePpm > rates.takerRatePpm ? rates.makerRatePpm : rates.takerRatePpm;
  return assertNumeric38(notional + calculateFee(notional, worstRate), 'reservation');
}

export function calculateRemainingBuyReservation(
  openQuantity: bigint,
  limitPrice: bigint,
  rates: FeeRates,
): bigint {
  assertNonNegative(openQuantity, 'openQuantity');
  if (openQuantity === 0n) return 0n;
  return calculateBuyReservation(openQuantity, limitPrice, rates);
}

export function assertNumeric38(value: bigint, field: string): bigint {
  if (value < 0n || value > MAX_NUMERIC_38) {
    throw new OmsError('VALIDATION_ERROR', `${field} exceeds NUMERIC(38,0)`, 400, [
      { field, reason: `${field} must fit NUMERIC(38,0)` },
    ]);
  }
  return value;
}

function assertPositive(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new OmsError('VALIDATION_ERROR', `${field} must be a positive bigint`, 400, [
      { field, reason: `${field} must be a positive bigint in minor units` },
    ]);
  }
  assertNumeric38(value, field);
}

function assertNonNegative(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new OmsError('VALIDATION_ERROR', `${field} must be a non-negative bigint`, 400, [
      { field, reason: `${field} must be a non-negative bigint in minor units` },
    ]);
  }
  assertNumeric38(value, field);
}

function assertRate(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > FEE_RATE_SCALE) {
    throw new OmsError('VALIDATION_ERROR', 'fee rate is outside the supported range', 400);
  }
}

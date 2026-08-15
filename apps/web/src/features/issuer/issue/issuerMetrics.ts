import { parseUnsignedInteger } from '../../../lib/integer-format.js';

export function collateralCoverageBps(
  verified: string,
  supplyCap: string,
  unitPerToken: string,
): string | null {
  const required =
    parseUnsignedInteger(supplyCap, 'supplyCap') *
    parseUnsignedInteger(unitPerToken, 'unitPerToken');
  if (required === 0n) return null;
  return ((parseUnsignedInteger(verified, 'verified') * 10_000n) / required).toString();
}

export function availableForPlacement(supplyCap: string, circulatingSupply: string): string {
  const available =
    parseUnsignedInteger(supplyCap, 'supplyCap') -
    parseUnsignedInteger(circulatingSupply, 'circulatingSupply');
  return (available < 0n ? 0n : available).toString();
}

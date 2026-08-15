import { describe, expect, it } from 'vitest';

import { availableForPlacement, collateralCoverageBps } from './issuerMetrics.js';

describe('issuer bigint metrics', () => {
  it('calculates coverage with integer truncation', () => {
    expect(collateralCoverageBps('5000', '4950', '1')).toBe('10101');
    expect(collateralCoverageBps('1', '3', '1')).toBe('3333');
  });

  it('never exposes a negative placement remainder', () => {
    expect(availableForPlacement('4950', '3500')).toBe('1450');
    expect(availableForPlacement('10', '11')).toBe('0');
  });
});

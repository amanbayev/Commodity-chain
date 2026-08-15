import { describe, expect, it } from 'vitest';

import {
  formatBasisPoints,
  formatInteger,
  formatMoney,
  multiplyIntegerStrings,
} from './integer-format.js';

describe('integer formatting', () => {
  it('formats NUMERIC(38,0) values without precision loss', () => {
    expect(formatMoney('99999999999999999999999999999999999999', 'KZT')).toBe(
      '99 999 999 999 999 999 999 999 999 999 999 999 999 ₸',
    );
  });

  it('formats signed integer basis points without floating point arithmetic', () => {
    expect(formatBasisPoints('180')).toBe('+1,8%');
    expect(formatBasisPoints('-40')).toBe('−0,4%');
    expect(formatBasisPoints('0')).toBe('0%');
  });

  it('multiplies large integer strings exactly', () => {
    expect(multiplyIntegerStrings('9007199254740993', '1000000')).toBe('9007199254740993000000');
    expect(formatInteger('-1000000')).toBe('−1 000 000');
  });

  it('rejects decimal and exponent notation', () => {
    expect(() => formatInteger('1.5')).toThrow(TypeError);
    expect(() => multiplyIntegerStrings('1e3', '2')).toThrow(TypeError);
  });
});

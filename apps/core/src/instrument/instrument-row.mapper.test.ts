import { describe, expect, it } from 'vitest';

import { rowToInstrument } from './instrument-row.mapper.js';

describe('instrument database row mapper', () => {
  it('maps every persisted numeric instrument quantity to bigint', () => {
    const instrument = rowToInstrument({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'COMMODITY_CLAIM',
      legal_nature: 'CLAIM_RIGHT',
      status: 'DRAFT',
      currency: 'KZT',
      unit: 'GRAM',
      unit_per_token: '10000000000000000000000000000000000001',
      supply_cap: '99999999999999999999999999999999999999',
      circulating_supply: '5000',
      version: '1',
      extensions: {},
      created_at: '2026-08-15T00:00:00.000Z',
      updated_at: new Date('2026-08-15T01:00:00.000Z'),
    });

    expect(instrument.unitPerToken).toBe(10000000000000000000000000000000000001n);
    expect(instrument.supplyCap).toBe(99999999999999999999999999999999999999n);
    expect(instrument.circulatingSupply).toBe(5000n);
    expect(typeof instrument.unitPerToken).toBe('bigint');
    expect(typeof instrument.supplyCap).toBe('bigint');
    expect(typeof instrument.circulatingSupply).toBe('bigint');
  });
});

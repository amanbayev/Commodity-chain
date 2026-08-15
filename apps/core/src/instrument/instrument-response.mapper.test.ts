import { describe, expect, it } from 'vitest';

import { instrumentResponseToJson } from './instrument-response.mapper.js';

describe('instrument API response mapper', () => {
  it('serializes domain bigint quantities to contract strings recursively', () => {
    expect(
      instrumentResponseToJson({
        instrument: { unitPerToken: 1n, supplyCap: 5_000n, circulatingSupply: 25n },
        positions: [{ reserved: 100n, available: 0n }],
      }),
    ).toEqual({
      instrument: { unitPerToken: '1', supplyCap: '5000', circulatingSupply: '25' },
      positions: [{ reserved: '100', available: '0' }],
    });
  });
});

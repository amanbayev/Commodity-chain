import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assertOrderAdmission } from './admission-policy.js';

const participantId = randomUUID();
const instrumentId = randomUUID();

describe('OMS admission policy', () => {
  it.each([
    ['PARTICIPANT_NOT_FOUND', false, 'ACTIVE', true],
    ['RESOURCE_NOT_FOUND', true, null, true],
    ['INVALID_STATUS', true, 'COLLATERALIZED', true],
    ['INSTRUMENT_NOT_TRADABLE', true, 'ACTIVE', false],
  ] as const)('returns deterministic failure %s', (code, participantExists, status, tradeable) => {
    expect(() =>
      assertOrderAdmission({
        participantId,
        participantExists,
        instrumentId,
        instrumentStatus: status,
        tradeable,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it.each(['PRIMARY', 'ACTIVE'])('admits status %s', (instrumentStatus) => {
    expect(() =>
      assertOrderAdmission({
        participantId,
        participantExists: true,
        instrumentId,
        instrumentStatus,
        tradeable: true,
      }),
    ).not.toThrow();
  });
});

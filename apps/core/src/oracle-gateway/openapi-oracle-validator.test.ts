import { describe, expect, it } from 'vitest';

import { OpenApiOracleEnvelopeValidator } from './openapi-oracle-validator.js';

const validEnvelope = {
  eventId: '41db1020-ae4c-4ce0-8936-c48f33a06a77',
  schemaVersion: '1',
  instrumentId: '048c13bb-7af1-44e4-9219-22b2cb58c25d',
  assetId: 'ezr-1',
  eventType: 'RECEIPT_LOCKED',
  quantity: '1000',
  unit: 'KG',
  observedAt: '2026-08-14T10:00:00.000Z',
  effectiveAt: '2026-08-14T10:00:00.000Z',
  sourceId: 'mock-ezr',
  evidenceHash: 'sha256:0123456789abcdef',
  nonce: 1,
  signature: { algorithm: 'Ed25519', keyId: 'mock-key-1', value: 'a'.repeat(86) },
};

describe('OpenApiOracleEnvelopeValidator', () => {
  const validator = new OpenApiOracleEnvelopeValidator();

  it('accepts an OracleEventEnvelope from the OpenAPI source of truth', () => {
    expect(validator.validate(validEnvelope).valid).toBe(true);
  });

  it('rejects an additional property without removing it', () => {
    const payload = { ...validEnvelope, unexpected: true };
    const result = validator.validate(payload);

    expect(result.valid).toBe(false);
    expect(payload).toHaveProperty('unexpected', true);
  });
});

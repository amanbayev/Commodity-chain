import { describe, expect, it } from 'vitest';

import { OpenApiOracleEnvelopeValidator } from '../oracle-gateway/openapi-oracle-validator.js';
import { mapOracle, type OracleRow } from './elevator.service.js';

const row: OracleRow = {
  asset_id: 'ezr-2026-001',
  correlation_id: '23c9bd58-8113-4876-9ef4-d3df9fc6712d',
  created_at: '2026-08-15T10:00:00.000Z',
  effective_at: '2026-08-15T10:00:00.000Z',
  event_id: '41db1020-ae4c-4ce0-8936-c48f33a06a77',
  event_type: 'GOODS_RELEASED',
  evidence_hash: `sha256:${'a'.repeat(64)}`,
  extensions: {},
  failure_code: null,
  failure_details: null,
  id: '1',
  instrument_id: '048c13bb-7af1-44e4-9219-22b2cb58c25d',
  nonce: '7',
  observed_at: '2026-08-15T10:00:00.000Z',
  quantity: '20',
  redemption_id: 'RED-2026-0107',
  schema_version: '1',
  signature: { algorithm: 'Ed25519', keyId: 'mock-key-1', value: 'a'.repeat(86) },
  source_id: '44444444-4444-4444-8444-444444444444',
  status: 'APPLIED',
  unit: 'MT',
};

describe('elevator oracle projection', () => {
  it('reconstructs an envelope that strictly conforms to the contract schema', () => {
    const projected = mapOracle(row);
    expect(new OpenApiOracleEnvelopeValidator().validate(projected.envelope)).toEqual({
      valid: true,
      value: projected.envelope,
    });
  });
});

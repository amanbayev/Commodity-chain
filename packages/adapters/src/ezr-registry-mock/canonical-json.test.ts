import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { UnsignedOracleEventEnvelope } from '../ezr-registry/types.js';
import { canonicalJson, canonicalOracleEventPayload } from './canonical-json.js';
import { signOracleEvent, verifyOracleEventSignature } from './signing.js';

const unsigned: UnsignedOracleEventEnvelope = {
  eventId: 'a18d9ccd-bbba-4c6d-aae7-d3699f010a1f',
  schemaVersion: '1',
  instrumentId: 'e46b44a9-04de-495d-9d33-a797b0e3cb5f',
  assetId: 'receipt-1',
  eventType: 'RECEIPT_LOCKED',
  quantity: '125000',
  unit: 'GRAM',
  observedAt: '2026-08-14T00:00:00.000Z',
  effectiveAt: '2026-08-14T00:00:00.000Z',
  sourceId: 'mock-ezr-registry',
  evidenceHash: 'sha256:0123456789abcdef',
  nonce: 1,
  extensions: { z: [3, { b: true, a: null }], a: 'first' },
};

describe('canonical JSON and Ed25519', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: 'value' } })).toBe(
      '{"a":{"x":"value","y":true},"z":[2,1]}',
    );
  });

  it('rejects floating point and unsafe JSON numbers', () => {
    expect(() => canonicalJson({ quantity: 1.5 })).toThrow(/safe integer/u);
    expect(() => canonicalJson({ nonce: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/u);
    expect(() => canonicalJson({ quantity: 1n })).toThrow(/Unsupported/u);
    expect(() => canonicalJson({ omitted: undefined })).toThrow(/undefined/u);
    expect(() => canonicalJson(new Date())).toThrow(/plain objects/u);
  });

  it('signs the canonical envelope without the signature field', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const envelope = signOracleEvent(unsigned, 'mock-key-1', privateKey);

    expect(canonicalOracleEventPayload(envelope)).toBe(canonicalJson(unsigned));
    expect(verifyOracleEventSignature(envelope, publicKey)).toBe(true);
    expect(verifyOracleEventSignature({ ...envelope, quantity: '125001' }, publicKey)).toBe(false);
  });
});

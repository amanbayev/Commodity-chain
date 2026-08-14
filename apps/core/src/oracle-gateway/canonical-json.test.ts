import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalizeJson, canonicalOraclePayload } from './canonical-json.js';
import { Ed25519SignatureVerifier } from './ed25519-verifier.js';

describe('oracle canonicalization and Ed25519', () => {
  it('sorts object keys recursively, preserves arrays, and omits signature', () => {
    expect(canonicalizeJson({ z: 1, a: { y: 2, x: 1 }, list: [{ b: 2, a: 1 }] })).toBe(
      '{"a":{"x":1,"y":2},"list":[{"a":1,"b":2}],"z":1}',
    );
    expect(
      Buffer.from(canonicalOraclePayload({ z: 1, signature: { value: 'ignored' }, a: 2 })).toString(
        'utf8',
      ),
    ).toBe('{"a":2,"z":1}');
  });

  it('verifies only a canonical unpadded base64url Ed25519 signature', () => {
    const keyPair = generateKeyPairSync('ed25519');
    const canonicalPayload = canonicalOraclePayload({ eventId: 'event', signature: {} });
    const signature = sign(null, canonicalPayload, keyPair.privateKey).toString('base64url');
    const verifier = new Ed25519SignatureVerifier();

    expect(
      verifier.verify({
        canonicalPayload,
        signature,
        publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }),
    ).toBe(true);
    expect(
      verifier.verify({
        canonicalPayload: Buffer.from('tampered'),
        signature,
        publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }),
    ).toBe(false);
  });
});

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import type {
  OracleEventEnvelope,
  OracleSignature,
  UnsignedOracleEventEnvelope,
} from '../ezr-registry/types.js';
import { canonicalJson, canonicalOracleEventPayload } from './canonical-json.js';

export function signOracleEvent(
  event: UnsignedOracleEventEnvelope,
  keyId: string,
  privateKeyPem: string,
): OracleEventEnvelope {
  const value = sign(
    null,
    Buffer.from(canonicalJson(event), 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64url');

  return {
    ...event,
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value,
    },
  };
}

export function verifyOracleEventSignature(
  envelope: OracleEventEnvelope,
  publicKeyPem: string,
): boolean {
  if (envelope.signature.algorithm !== 'Ed25519') {
    return false;
  }

  return verify(
    null,
    Buffer.from(canonicalOracleEventPayload(envelope), 'utf8'),
    createPublicKey(publicKeyPem),
    Buffer.from(envelope.signature.value, 'base64url'),
  );
}

export function signatureHeader(signature: OracleSignature): string {
  return signature.value;
}

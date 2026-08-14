import { verify } from 'node:crypto';

import { decodeUnpaddedBase64Url } from './canonical-json.js';

export interface OracleSignatureVerifier {
  verify(input: {
    readonly canonicalPayload: Uint8Array;
    readonly signature: string;
    readonly publicKeyPem: string;
  }): boolean;
}

export class Ed25519SignatureVerifier implements OracleSignatureVerifier {
  public verify(input: {
    readonly canonicalPayload: Uint8Array;
    readonly signature: string;
    readonly publicKeyPem: string;
  }): boolean {
    const signature = decodeUnpaddedBase64Url(input.signature);
    if (signature === null || signature.byteLength !== 64) {
      return false;
    }

    try {
      return verify(null, input.canonicalPayload, input.publicKeyPem, signature);
    } catch {
      return false;
    }
  }
}

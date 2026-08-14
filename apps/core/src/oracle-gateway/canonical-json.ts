const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

export function canonicalOraclePayload(envelope: object): Uint8Array {
  const unsignedEnvelope = Object.fromEntries(
    Object.entries(envelope as Readonly<Record<string, unknown>>).filter(
      ([key]) => key !== 'signature',
    ),
  );
  return Buffer.from(canonicalizeJson(unsignedEnvelope), 'utf8');
}

export function decodeUnpaddedBase64Url(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value) || value.includes('=')) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('Canonical JSON accepts only safe integer numbers');
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain objects');
    }
    const entries = Object.entries(value as Readonly<Record<string, unknown>>);
    if (entries.some(([, child]) => child === undefined)) {
      throw new TypeError('Canonical JSON does not accept undefined values');
    }
    entries.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`)
      .join(',')}}`;
  }

  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

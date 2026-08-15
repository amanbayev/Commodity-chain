import type { OracleEventEnvelope, UnsignedOracleEventEnvelope } from '../ezr-registry/types.js';

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

export function canonicalOracleEventPayload(envelope: OracleEventEnvelope): string {
  const unsigned: UnsignedOracleEventEnvelope = {
    eventId: envelope.eventId,
    schemaVersion: envelope.schemaVersion,
    instrumentId: envelope.instrumentId,
    assetId: envelope.assetId,
    eventType: envelope.eventType,
    quantity: envelope.quantity,
    unit: envelope.unit,
    observedAt: envelope.observedAt,
    effectiveAt: envelope.effectiveAt,
    sourceId: envelope.sourceId,
    ...(envelope.redemptionId === undefined ? {} : { redemptionId: envelope.redemptionId }),
    evidenceHash: envelope.evidenceHash,
    nonce: envelope.nonce,
    ...(envelope.extensions === undefined ? {} : { extensions: envelope.extensions }),
  };
  return canonicalJson(unsigned);
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
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, item]) => item === undefined)) {
      throw new TypeError('Canonical JSON does not accept undefined values');
    }
    entries.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`)
      .join(',')}}`;
  }

  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { OracleEventEnvelope } from '../ezr-registry/types.js';
import { HttpOracleEventPublisher } from './oracle-http-publisher.js';

const envelope: OracleEventEnvelope = {
  eventId: randomUUID(),
  schemaVersion: '1',
  instrumentId: randomUUID(),
  assetId: randomUUID(),
  eventType: 'STOCK_UPDATED',
  quantity: '42',
  unit: 'GRAM',
  observedAt: '2026-08-14T00:00:00.000Z',
  effectiveAt: '2026-08-14T00:00:00.000Z',
  sourceId: 'mock-ezr-registry',
  evidenceHash: 'sha256:0123456789abcdef',
  nonce: 1,
  signature: { algorithm: 'Ed25519', keyId: 'mock-key-1', value: 'signed-value' },
};

describe('HttpOracleEventPublisher', () => {
  it('posts the contract headers and signed envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          eventId: envelope.eventId,
          acceptedAt: envelope.observedAt,
          status: 'APPLIED',
          replayed: false,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const publisher = new HttpOracleEventPublisher({
      baseUrl: 'http://core.test/',
      bearerToken: 'test-token',
      fetch: fetchMock,
    });
    const correlationId = randomUUID();

    await publisher.publish(envelope, { correlationId, idempotencyKey: envelope.eventId });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://core.test/v1/oracle-events');
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'Idempotency-Key': envelope.eventId,
      'X-Correlation-Id': correlationId,
      'X-Oracle-Signature': envelope.signature.value,
    });
    expect(JSON.parse(String(request?.body))).toEqual(envelope);
  });

  it('rejects non-success responses', async () => {
    const publisher = new HttpOracleEventPublisher({
      baseUrl: 'http://core.test',
      bearerToken: 'test-token',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ code: 'ORACLE_SIGNATURE_INVALID' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });

    await expect(
      publisher.publish(envelope, {
        correlationId: randomUUID(),
        idempotencyKey: envelope.eventId,
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
  });
});

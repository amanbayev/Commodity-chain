// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../api/client.js';
import { confirmShipment } from './elevatorApi.js';

describe('elevator shipment API', () => {
  it('returns the changed redemption status reported by core after confirmation', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          receipt: {
            receiptId: 'ezr-1',
            owner: 'owner-1',
            commodity: 'Wheat',
            quantity: '20',
            unit: 'MT',
            elevatorId: 'elevator-1',
            status: 'RELEASED',
            instrumentId: '048c13bb-7af1-44e4-9219-22b2cb58c25d',
            redemptionId: '41db1020-ae4c-4ce0-8936-c48f33a06a77',
            createdAt: '2026-08-15T10:00:00Z',
            updatedAt: '2026-08-15T10:00:00Z',
          },
          oracleEvent: { envelope: {}, status: 'APPLIED', receivedAt: '2026-08-15T10:00:00Z' },
          redemption: {
            id: '41db1020-ae4c-4ce0-8936-c48f33a06a77',
            holder: 'holder-1',
            instrumentId: '048c13bb-7af1-44e4-9219-22b2cb58c25d',
            quantity: '20',
            method: 'PHYSICAL_DELIVERY',
            status: 'COMPLETED',
            delivery: {
              elevatorId: 'elevator-1',
              requestedDate: '2026-08-15',
              recipient: 'Logistics',
              transport: 'KZ 123 ABC',
            },
            proofs: [],
            createdAt: '2026-08-15T10:00:00Z',
            updatedAt: '2026-08-15T10:00:00Z',
          },
        }),
        {
          headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': crypto.randomUUID() },
          status: 202,
        },
      ),
    );
    const client = createApiClient({ fetchImplementation });

    const result = await confirmShipment(
      client,
      'elevator-1',
      '41db1020-ae4c-4ce0-8936-c48f33a06a77',
    );

    expect(result.redemption?.status).toBe('COMPLETED');
    const [, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(new Headers(request?.headers).get('Idempotency-Key')).not.toBeNull();
  });
});

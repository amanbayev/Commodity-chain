import { randomUUID } from 'node:crypto';

import type { PostgresLedger } from '@commodity-chain/ledger';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { InstrumentCommandQueue } from './instrument-command-queue.js';
import { OmsService } from './oms.service.js';

describe('OmsService command validation without PostgreSQL', () => {
  const pool = {} as Pool;
  const service = new OmsService(pool, {} as PostgresLedger, new InstrumentCommandQueue());

  it('rejects reserved MARKET with its deterministic code before database access', async () => {
    const result = await service.place({
      participantId: randomUUID(),
      clientOrderId: 'market-order',
      instrumentId: randomUUID(),
      side: 'BUY',
      type: 'MARKET',
      quantity: 10n,
      idempotencyKey: 'market-order-key',
      correlationId: randomUUID(),
    });
    expect(result.body).toMatchObject({ code: 'ORDER_TYPE_NOT_AVAILABLE' });
  });

  it.each([
    ['participantId', { participantId: 'not-a-uuid' }],
    ['instrumentId', { instrumentId: 'not-a-uuid' }],
    ['correlationId', { correlationId: 'not-a-uuid' }],
    ['price', { price: 1.5 as unknown as bigint }],
    ['quantity', { quantity: 10 as unknown as bigint }],
  ])('returns VALIDATION_ERROR for %s', async (_field, override) => {
    const result = await service.place({
      participantId: randomUUID(),
      clientOrderId: 'limit-order',
      instrumentId: randomUUID(),
      side: 'BUY',
      type: 'LIMIT',
      price: 100n,
      quantity: 10n,
      idempotencyKey: 'limit-order-key',
      correlationId: randomUUID(),
      ...override,
    });
    expect(result.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

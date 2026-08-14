import { randomUUID } from 'node:crypto';

import type { MatchingEvent } from '@commodity-chain/matching-core';
import { describe, expect, it } from 'vitest';

import { deserializeMatchingEvent, serializeMatchingEvent } from './matching-event-codec.js';

describe('matching event persistence codec', () => {
  it('round-trips bigint fields without number conversion', () => {
    const event: MatchingEvent = {
      type: 'TradeExecuted',
      eventId: randomUUID(),
      nonce: 9_007_199_254_740_993n,
      exchangeSequenceNumber: 7n,
      eventIndex: 1,
      eventCount: 2,
      commandId: randomUUID(),
      occurredAt: '2026-08-14T12:00:00.000Z',
      tradeId: randomUUID(),
      instrumentId: randomUUID(),
      makerOrderId: randomUUID(),
      takerOrderId: randomUUID(),
      buyOrderId: randomUUID(),
      sellOrderId: randomUUID(),
      price: 123n,
      quantity: 456n,
    };
    const serialized = serializeMatchingEvent(event);

    expect(serialized['nonce']).toBe('9007199254740993');
    expect(serialized['price']).toBe('123');
    expect(deserializeMatchingEvent(serialized)).toEqual(event);
  });
});

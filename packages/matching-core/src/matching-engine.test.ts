import { describe, expect, it } from 'vitest';

import { deterministicUuid } from './deterministic-id.js';
import { MatchingEngine } from './matching-engine.js';
import { eventId, replay } from './state.js';
import type { CancelCommand, EngineConfig, MatchingEvent, PlaceCommand } from './types.js';

const instrumentId = 'grain-kz-2026';
const occurredAt = '2026-08-14T12:00:00.000Z';
const replayConfig = {
  instrumentId,
  tickSize: 5n,
  lotSize: 10n,
  selfTradePolicy: 'CANCEL_NEWEST' as const,
};

describe('MatchingEngine scenarios', () => {
  it('emits the exact full-fill stream at the resting price', () => {
    const engine = createEngine();
    engine.submitCommand(place(1, 'SELL', 100n, 50n, 'seller'));

    const events = engine.submitCommand(place(2, 'BUY', 110n, 50n, 'buyer'));

    expect(events).toEqual([
      {
        type: 'OrderAccepted',
        eventId: eventId(instrumentId, 2n),
        nonce: 2n,
        exchangeSequenceNumber: 2n,
        eventIndex: 0,
        eventCount: 2,
        commandId: 'command-2',
        occurredAt,
        orderId: 'order-2',
        participantId: 'buyer',
        clientOrderId: 'client-2',
        instrumentId,
        side: 'BUY',
        orderType: 'LIMIT',
        price: 110n,
        quantity: 50n,
      },
      {
        type: 'TradeExecuted',
        eventId: eventId(instrumentId, 3n),
        nonce: 3n,
        exchangeSequenceNumber: 2n,
        eventIndex: 1,
        eventCount: 2,
        commandId: 'command-2',
        occurredAt,
        tradeId: deterministicUuid(`matching:trade:${instrumentId}:2:1`),
        instrumentId,
        makerOrderId: 'order-1',
        takerOrderId: 'order-2',
        buyOrderId: 'order-2',
        sellOrderId: 'order-1',
        price: 100n,
        quantity: 50n,
      },
    ]);
    expect(engine.getState().ordersById.get('order-1')?.status).toBe('FILLED');
    expect(engine.getState().ordersById.get('order-2')?.status).toBe('FILLED');
    expect(engine.getOrderBook(10)).toMatchObject({ bids: [], asks: [], sequence: 2n });
  });

  it('cascades partial fills by price then original sequence', () => {
    const engine = createEngine();
    engine.submitCommand(place(1, 'SELL', 100n, 30n, 'seller-a'));
    engine.submitCommand(place(2, 'SELL', 100n, 20n, 'seller-b'));
    engine.submitCommand(place(3, 'SELL', 110n, 40n, 'seller-c'));

    const events = engine.submitCommand(place(4, 'BUY', 110n, 70n, 'buyer'));
    const trades = events.filter(
      (event): event is Extract<MatchingEvent, { type: 'TradeExecuted' }> =>
        event.type === 'TradeExecuted',
    );

    expect(
      trades.map(({ makerOrderId, price, quantity }) => ({ makerOrderId, price, quantity })),
    ).toEqual([
      { makerOrderId: 'order-1', price: 100n, quantity: 30n },
      { makerOrderId: 'order-2', price: 100n, quantity: 20n },
      { makerOrderId: 'order-3', price: 110n, quantity: 20n },
    ]);
    expect(engine.getState().ordersById.get('order-3')).toMatchObject({
      openQuantity: 20n,
      status: 'PARTIALLY_FILLED',
      acceptedSequence: 3n,
    });
    expect(engine.getOrderBook(10).asks).toEqual([{ price: 110n, quantity: 20n, orderCount: 1 }]);
  });

  it('cancels only the open remainder and rejects cancellation of a filled order', () => {
    const engine = createEngine();
    engine.submitCommand(place(1, 'SELL', 100n, 40n, 'seller'));
    engine.submitCommand(place(2, 'BUY', 100n, 20n, 'buyer'));

    const cancelled = engine.submitCommand(cancel(3, 'order-1', 'seller'));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      type: 'OrderCancelled',
      orderId: 'order-1',
      cancelledQuantity: 20n,
      reason: 'USER_REQUESTED',
    });

    engine.submitCommand(place(4, 'SELL', 100n, 20n, 'seller-2'));
    engine.submitCommand(place(5, 'BUY', 100n, 20n, 'buyer-2'));
    const rejected = engine.submitCommand(cancel(6, 'order-4', 'seller-2'));
    expect(rejected[0]).toMatchObject({
      type: 'OrderRejected',
      reason: 'ORDER_NOT_CANCELLABLE',
    });
  });

  it('cancels the newest aggressor on self-trade without touching the resting order', () => {
    const engine = createEngine();
    engine.submitCommand(place(1, 'SELL', 100n, 50n, 'same-party'));

    const events = engine.submitCommand(place(2, 'BUY', 110n, 30n, 'same-party'));

    expect(events.map((event) => event.type)).toEqual(['OrderAccepted', 'OrderCancelled']);
    expect(events[1]).toMatchObject({
      orderId: 'order-2',
      cancelledQuantity: 30n,
      reason: 'SELF_TRADE_PREVENTED',
    });
    expect(engine.getState().events.filter((event) => event.type === 'TradeExecuted')).toHaveLength(
      0,
    );
    expect(engine.getState().ordersById.get('order-1')).toMatchObject({
      openQuantity: 50n,
      status: 'OPEN',
    });
    expect(engine.getState().ordersById.get('order-2')?.status).toBe('CANCELLED');
  });

  it('returns the original result for a duplicate participant clientOrderId', () => {
    const engine = createEngine();
    const original = engine.submitCommand(place(1, 'BUY', 100n, 20n, 'buyer'));
    const duplicate = engine.submitCommand({
      ...place(99, 'SELL', 500n, 100n, 'buyer'),
      clientOrderId: 'client-1',
    });

    expect(duplicate).toEqual(original);
    expect(engine.getState().events).toHaveLength(1);
    expect(engine.getState().nextExchangeSequenceNumber).toBe(2n);
    expect(engine.getState().ordersById.has('order-99')).toBe(false);
  });

  it('validates bigint, tick size, lot size, and reserved MARKET before acceptance', () => {
    const engine = createEngine();
    const invalidCommands: PlaceCommand[] = [
      { ...place(1, 'BUY', 101n, 20n, 'buyer'), price: 101n },
      { ...place(2, 'BUY', 100n, 21n, 'buyer'), quantity: 21n },
      omitPrice({ ...place(3, 'BUY', 100n, 20n, 'buyer'), type: 'MARKET' }),
      { ...place(4, 'BUY', 100n, 20n, 'buyer'), price: 1.5 as unknown as bigint },
      { ...place(5, 'BUY', 100n, 20n, 'buyer'), quantity: 20 as unknown as bigint },
    ];

    expect(
      invalidCommands.map((command) => {
        const event = engine.submitCommand(command)[0];
        return event?.type === 'OrderRejected' ? event.reason : 'NOT_REJECTED';
      }),
    ).toEqual([
      'PRICE_NOT_ON_TICK',
      'QUANTITY_NOT_ON_LOT',
      'ORDER_TYPE_NOT_AVAILABLE',
      'PRICE_NOT_POSITIVE',
      'QUANTITY_NOT_POSITIVE',
    ]);
    expect(engine.getState().ordersById).toHaveLength(0);
  });

  it('replays an expiry event and reconstructs the exact state', () => {
    const engine = createEngine();
    engine.submitCommand(place(1, 'BUY', 100n, 20n, 'buyer'));
    const accepted = engine.getState().events[0]!;
    const expiry: MatchingEvent = {
      type: 'OrderExpired',
      eventId: eventId(instrumentId, 2n),
      nonce: 2n,
      exchangeSequenceNumber: 2n,
      eventIndex: 0,
      eventCount: 1,
      commandId: 'expiry-command',
      occurredAt,
      orderId: 'order-1',
      expiredQuantity: 20n,
    };

    const state = replay(replayConfig, [accepted, expiry]);
    expect(state.ordersById.get('order-1')).toMatchObject({
      status: 'EXPIRED',
      openQuantity: 0n,
    });
    expect(state.events).toEqual([accepted, expiry]);
  });
});

function createEngine(): MatchingEngine {
  const config: EngineConfig = { ...replayConfig, clock: () => occurredAt };
  return new MatchingEngine(config);
}

function place(
  ordinal: number,
  side: 'BUY' | 'SELL',
  price: bigint,
  quantity: bigint,
  participantId: string,
): PlaceCommand {
  return {
    kind: 'PLACE',
    commandId: `command-${ordinal}`,
    orderId: `order-${ordinal}`,
    participantId,
    clientOrderId: `client-${ordinal}`,
    instrumentId,
    side,
    type: 'LIMIT',
    price,
    quantity,
  };
}

function cancel(ordinal: number, orderId: string, participantId: string): CancelCommand {
  return { kind: 'CANCEL', commandId: `command-${ordinal}`, orderId, participantId };
}

function omitPrice(command: PlaceCommand): PlaceCommand {
  return {
    kind: command.kind,
    commandId: command.commandId,
    orderId: command.orderId,
    participantId: command.participantId,
    clientOrderId: command.clientOrderId,
    instrumentId: command.instrumentId,
    side: command.side,
    type: command.type,
    quantity: command.quantity,
  };
}

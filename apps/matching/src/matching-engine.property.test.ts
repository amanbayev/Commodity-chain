import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MatchingEngine } from './matching-engine.js';
import { replay } from './state.js';
import type { MatchingCommand, MatchingEvent, MatchingState } from './types.js';

const instrumentId = 'grain-kz-property';
const occurredAt = '2026-08-14T12:00:00.000Z';
const config = {
  instrumentId,
  tickSize: 5n,
  lotSize: 10n,
  selfTradePolicy: 'CANCEL_NEWEST' as const,
};

interface GeneratedOperation {
  readonly kind: 'PLACE' | 'CANCEL';
  readonly side: 'BUY' | 'SELL';
  readonly priceTicks: number;
  readonly lots: number;
  readonly participantIndex: number;
  readonly clientOrderIndex: number;
  readonly cancelTargetIndex: number;
}

describe('MatchingEngine deterministic properties', () => {
  it('replays 10,000 fixed-seed random commands to the same state and preserves invariants', async () => {
    const operationArbitrary = fc.record<GeneratedOperation>({
      kind: fc.constantFrom('PLACE', 'CANCEL'),
      side: fc.constantFrom('BUY', 'SELL'),
      priceTicks: fc.integer({ min: 1, max: 40 }),
      lots: fc.integer({ min: 1, max: 10 }),
      participantIndex: fc.integer({ min: 0, max: 19 }),
      clientOrderIndex: fc.integer({ min: 0, max: 15_000 }),
      cancelTargetIndex: fc.integer({ min: 0, max: 9_999 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArbitrary, { minLength: 10_000, maxLength: 10_000 }),
        async (operations) => {
          const engine = new MatchingEngine({ ...config, clock: () => occurredAt });
          const executedByOrder = new Map<string, bigint>();

          for (const [index, operation] of operations.entries()) {
            const command = toCommand(operation, index);
            const events = engine.submitCommand(command);
            const isOriginalResult = events[0]?.commandId === command.commandId;
            if (isOriginalResult) {
              assertTradeInvariants(engine.getState(), events, executedByOrder);
            }
            assertBookIsNotCrossed(engine);
          }

          const original = engine.getState();
          const rebuilt = replay(config, original.events);
          expect(hashState(rebuilt)).toBe(hashState(original));
          expect(hashValue(rebuilt.events)).toBe(hashValue(original.events));
        },
      ),
      {
        seed: 20_260_814,
        numRuns: 1,
        endOnFailure: true,
      },
    );
  }, 120_000);
});

function toCommand(operation: GeneratedOperation, index: number): MatchingCommand {
  const participantId = `participant-${operation.participantIndex}`;
  if (operation.kind === 'CANCEL') {
    const target = operation.cancelTargetIndex % Math.max(index, 1);
    return {
      kind: 'CANCEL',
      commandId: `command-${index}`,
      orderId: `order-${target}`,
      participantId,
    };
  }
  return {
    kind: 'PLACE',
    commandId: `command-${index}`,
    orderId: `order-${index}`,
    participantId,
    clientOrderId: `client-${operation.clientOrderIndex}`,
    instrumentId,
    side: operation.side,
    type: 'LIMIT',
    price: BigInt(operation.priceTicks) * config.tickSize,
    quantity: BigInt(operation.lots) * config.lotSize,
  };
}

function assertTradeInvariants(
  state: MatchingState,
  events: readonly MatchingEvent[],
  executedByOrder: Map<string, bigint>,
): void {
  for (const event of events) {
    if (event.type !== 'TradeExecuted') {
      continue;
    }
    const maker = state.ordersById.get(event.makerOrderId);
    const taker = state.ordersById.get(event.takerOrderId);
    expect(maker).toBeDefined();
    expect(taker).toBeDefined();
    if (maker === undefined || taker === undefined) {
      throw new Error('Trade references an unknown order');
    }
    expect(event.price).toBe(maker.price);
    expect(taker.side === 'BUY' ? taker.price >= event.price : taker.price <= event.price).toBe(
      true,
    );
    expect(maker.participantId).not.toBe(taker.participantId);

    for (const orderId of [event.makerOrderId, event.takerOrderId]) {
      const order = state.ordersById.get(orderId)!;
      const executed = (executedByOrder.get(orderId) ?? 0n) + event.quantity;
      executedByOrder.set(orderId, executed);
      expect(executed).toBeLessThanOrEqual(order.quantity);
    }
  }
}

function assertBookIsNotCrossed(engine: MatchingEngine): void {
  const snapshot = engine.getOrderBook(1);
  const bestBid = snapshot.bids[0];
  const bestAsk = snapshot.asks[0];
  if (bestBid !== undefined && bestAsk !== undefined) {
    expect(bestBid.price).toBeLessThan(bestAsk.price);
  }
}

function hashState(state: MatchingState): string {
  return hashValue(state);
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (typeof value === 'bigint') {
    return JSON.stringify(`${value}n`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('Canonical test state contains a non-integer number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    );
    return canonicalize(entries);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

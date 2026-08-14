import type {
  CommandResult,
  EngineOrder,
  MatchingEvent,
  MatchingState,
  OrderBookLevel,
  OrderBookSnapshot,
  OrderSide,
  ReplayConfig,
} from './types.js';

const INITIAL_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function createInitialState(config: ReplayConfig): MatchingState {
  assertReplayConfig(config);
  return {
    instrumentId: config.instrumentId,
    tickSize: config.tickSize,
    lotSize: config.lotSize,
    selfTradePolicy: config.selfTradePolicy,
    nextExchangeSequenceNumber: 1n,
    nextEventNonce: 1n,
    lastEventAt: INITIAL_TIMESTAMP,
    ordersById: new Map(),
    clientOrderIndex: new Map(),
    commandResults: new Map(),
    events: [],
  };
}

export function replay(config: ReplayConfig, events: readonly MatchingEvent[]): MatchingState {
  let state = createInitialState(config);
  validateEventLog(events, config.instrumentId);
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

export function applyEvents(state: MatchingState, events: readonly MatchingEvent[]): MatchingState {
  let next = state;
  for (const event of events) {
    next = applyEvent(next, event);
  }
  return next;
}

export function getOrderBookSnapshot(state: MatchingState, depth: number): OrderBookSnapshot {
  if (!Number.isSafeInteger(depth) || depth <= 0) {
    throw new TypeError('depth must be a positive safe integer');
  }

  return {
    instrumentId: state.instrumentId,
    sequence: state.nextExchangeSequenceNumber - 1n,
    snapshotAt: state.lastEventAt,
    bids: aggregateLevels(openOrders(state, 'BUY'), depth),
    asks: aggregateLevels(openOrders(state, 'SELL'), depth),
  };
}

export function openOrders(state: MatchingState, side: OrderSide): readonly EngineOrder[] {
  return [...state.ordersById.values()]
    .filter((order) => order.side === side && order.openQuantity > 0n)
    .sort(orderComparator(side));
}

export function clientOrderKey(participantId: string, clientOrderId: string): string {
  return `${participantId.length}:${participantId}${clientOrderId}`;
}

function applyEvent(state: MatchingState, event: MatchingEvent): MatchingState {
  const orders = new Map(state.ordersById);
  const clientOrderIndex = new Map(state.clientOrderIndex);
  const commandResults = new Map(state.commandResults);
  const eventLog = [...state.events, event];

  switch (event.type) {
    case 'OrderAccepted': {
      orders.set(event.orderId, {
        orderId: event.orderId,
        participantId: event.participantId,
        clientOrderId: event.clientOrderId,
        instrumentId: event.instrumentId,
        side: event.side,
        type: event.orderType,
        price: event.price,
        quantity: event.quantity,
        openQuantity: event.quantity,
        status: 'OPEN',
        acceptedSequence: event.exchangeSequenceNumber,
        tradeIds: [],
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
      clientOrderIndex.set(
        clientOrderKey(event.participantId, event.clientOrderId),
        event.commandId,
      );
      break;
    }
    case 'OrderRejected': {
      if (event.clientOrderId !== undefined) {
        clientOrderIndex.set(
          clientOrderKey(event.participantId, event.clientOrderId),
          event.commandId,
        );
      }
      break;
    }
    case 'TradeExecuted': {
      applyTradeToOrder(
        orders,
        event.makerOrderId,
        event.tradeId,
        event.quantity,
        event.occurredAt,
      );
      applyTradeToOrder(
        orders,
        event.takerOrderId,
        event.tradeId,
        event.quantity,
        event.occurredAt,
      );
      break;
    }
    case 'OrderCancelled': {
      const order = requireOrder(orders, event.orderId, event.type);
      if (order.openQuantity !== event.cancelledQuantity) {
        throw new Error(
          `OrderCancelled quantity does not match open quantity for ${event.orderId}`,
        );
      }
      orders.set(event.orderId, {
        ...order,
        openQuantity: 0n,
        status: 'CANCELLED',
        updatedAt: event.occurredAt,
        closedAt: event.occurredAt,
      });
      break;
    }
    case 'OrderExpired': {
      const order = requireOrder(orders, event.orderId, event.type);
      if (order.openQuantity !== event.expiredQuantity) {
        throw new Error(`OrderExpired quantity does not match open quantity for ${event.orderId}`);
      }
      orders.set(event.orderId, {
        ...order,
        openQuantity: 0n,
        status: 'EXPIRED',
        updatedAt: event.occurredAt,
        closedAt: event.occurredAt,
      });
      break;
    }
  }

  const priorResult = commandResults.get(event.commandId);
  const resultEvents = priorResult === undefined ? [event] : [...priorResult.events, event];
  const result: CommandResult = {
    commandId: event.commandId,
    exchangeSequenceNumber: event.exchangeSequenceNumber,
    events: resultEvents,
  };
  commandResults.set(event.commandId, result);

  return {
    ...state,
    nextExchangeSequenceNumber:
      event.exchangeSequenceNumber >= state.nextExchangeSequenceNumber
        ? event.exchangeSequenceNumber + 1n
        : state.nextExchangeSequenceNumber,
    nextEventNonce: event.nonce >= state.nextEventNonce ? event.nonce + 1n : state.nextEventNonce,
    lastEventAt: event.occurredAt,
    ordersById: orders,
    clientOrderIndex,
    commandResults,
    events: eventLog,
  };
}

function applyTradeToOrder(
  orders: Map<string, EngineOrder>,
  orderId: string,
  tradeId: string,
  quantity: bigint,
  occurredAt: string,
): void {
  const order = requireOrder(orders, orderId, 'TradeExecuted');
  if (quantity <= 0n || quantity > order.openQuantity) {
    throw new Error(`Trade quantity exceeds open quantity for ${orderId}`);
  }
  const openQuantity = order.openQuantity - quantity;
  orders.set(orderId, {
    ...order,
    openQuantity,
    status: openQuantity === 0n ? 'FILLED' : 'PARTIALLY_FILLED',
    tradeIds: [...order.tradeIds, tradeId],
    updatedAt: occurredAt,
    ...(openQuantity === 0n ? { closedAt: occurredAt } : {}),
  });
}

function requireOrder(
  orders: ReadonlyMap<string, EngineOrder>,
  orderId: string,
  eventType: MatchingEvent['type'],
): EngineOrder {
  const order = orders.get(orderId);
  if (order === undefined) {
    throw new Error(`${eventType} references unknown order ${orderId}`);
  }
  return order;
}

function aggregateLevels(orders: readonly EngineOrder[], depth: number): readonly OrderBookLevel[] {
  const levels: OrderBookLevel[] = [];
  for (const order of orders) {
    const prior = levels.at(-1);
    if (prior?.price === order.price) {
      levels[levels.length - 1] = {
        price: prior.price,
        quantity: prior.quantity + order.openQuantity,
        orderCount: prior.orderCount + 1,
      };
      continue;
    }
    if (levels.length >= depth) {
      break;
    }
    levels.push({ price: order.price, quantity: order.openQuantity, orderCount: 1 });
  }
  return levels;
}

function orderComparator(side: OrderSide): (left: EngineOrder, right: EngineOrder) => number {
  return (left, right) => {
    if (left.price !== right.price) {
      if (side === 'BUY') {
        return left.price > right.price ? -1 : 1;
      }
      return left.price < right.price ? -1 : 1;
    }
    if (left.acceptedSequence !== right.acceptedSequence) {
      return left.acceptedSequence < right.acceptedSequence ? -1 : 1;
    }
    return left.orderId.localeCompare(right.orderId);
  };
}

function validateEventLog(events: readonly MatchingEvent[], instrumentId: string): void {
  let expectedNonce = 1n;
  let expectedSequence = 1n;
  let currentCommandId: string | undefined;
  let expectedEventIndex = 0;
  let expectedEventCount = 0;

  for (const event of events) {
    if (event.nonce !== expectedNonce) {
      throw new Error(`Expected event nonce ${expectedNonce}, received ${event.nonce}`);
    }
    if (event.eventId !== eventId(instrumentId, event.nonce)) {
      throw new Error(`Invalid deterministic eventId at nonce ${event.nonce}`);
    }
    if (event.exchangeSequenceNumber !== expectedSequence) {
      throw new Error(
        `Expected exchange sequence ${expectedSequence}, received ${event.exchangeSequenceNumber}`,
      );
    }
    if (event.eventCount <= 0 || event.eventIndex < 0 || event.eventIndex >= event.eventCount) {
      throw new Error(`Invalid event position at nonce ${event.nonce}`);
    }

    if (currentCommandId === undefined) {
      currentCommandId = event.commandId;
      expectedEventCount = event.eventCount;
      expectedEventIndex = 0;
    }
    if (
      event.commandId !== currentCommandId ||
      event.eventCount !== expectedEventCount ||
      event.eventIndex !== expectedEventIndex
    ) {
      throw new Error(`Non-contiguous command event group at nonce ${event.nonce}`);
    }

    expectedNonce += 1n;
    expectedEventIndex += 1;
    if (expectedEventIndex === expectedEventCount) {
      currentCommandId = undefined;
      expectedSequence += 1n;
    }
  }
  if (currentCommandId !== undefined) {
    throw new Error(`Incomplete event group for command ${currentCommandId}`);
  }
}

export function eventId(instrumentId: string, nonce: bigint): string {
  return `matching:${instrumentId}:${nonce}`;
}

function assertReplayConfig(config: ReplayConfig): void {
  if (typeof config.instrumentId !== 'string' || config.instrumentId.length === 0) {
    throw new TypeError('instrumentId must be a non-empty string');
  }
  assertPositiveBigInt(config.tickSize, 'tickSize');
  assertPositiveBigInt(config.lotSize, 'lotSize');
  if (config.selfTradePolicy !== 'CANCEL_NEWEST') {
    throw new TypeError('selfTradePolicy must be CANCEL_NEWEST');
  }
}

function assertPositiveBigInt(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new TypeError(`${field} must be a positive bigint`);
  }
}

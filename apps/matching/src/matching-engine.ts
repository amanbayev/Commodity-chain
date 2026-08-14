import {
  applyEvents,
  clientOrderKey,
  createInitialState,
  eventId,
  getOrderBookSnapshot,
  openOrders,
} from './state.js';
import type {
  CancelCommand,
  EngineConfig,
  EngineOrder,
  MatchingCommand,
  MatchingEngineApi,
  MatchingEvent,
  MatchingState,
  OrderBookSnapshot,
  OrderCancelledEvent,
  OrderRejectedEvent,
  PlaceCommand,
} from './types.js';

type DraftAccepted = Omit<
  Extract<MatchingEvent, { readonly type: 'OrderAccepted' }>,
  keyof import('./types.js').MatchingEventBase
>;
type DraftRejected = Omit<OrderRejectedEvent, keyof import('./types.js').MatchingEventBase>;
type DraftTrade = Omit<
  Extract<MatchingEvent, { readonly type: 'TradeExecuted' }>,
  keyof import('./types.js').MatchingEventBase
>;
type DraftCancelled = Omit<OrderCancelledEvent, keyof import('./types.js').MatchingEventBase>;
type DraftEvent = DraftAccepted | DraftRejected | DraftTrade | DraftCancelled;

export class MatchingEngine implements MatchingEngineApi {
  private state: MatchingState;

  public constructor(private readonly config: EngineConfig) {
    if (typeof config.clock !== 'function') {
      throw new TypeError('clock must be a function');
    }
    this.state = createInitialState(config);
  }

  public submitCommand(command: MatchingCommand): readonly MatchingEvent[] {
    const existingByCommand = this.existingCommandResult(command);
    if (existingByCommand !== undefined) {
      return existingByCommand;
    }

    if (command.kind === 'PLACE') {
      const existingByClientOrder = this.existingClientOrderResult(command);
      if (existingByClientOrder !== undefined) {
        return existingByClientOrder;
      }
    }

    const sequence = this.state.nextExchangeSequenceNumber;
    const occurredAt = this.readClock();
    const drafts = command.kind === 'PLACE' ? this.place(command, sequence) : this.cancel(command);
    const events = finalizeEvents(
      this.config.instrumentId,
      command.commandId,
      sequence,
      this.state.nextEventNonce,
      occurredAt,
      drafts,
    );
    this.state = applyEvents(this.state, events);
    return events;
  }

  public getOrderBook(depth: number): OrderBookSnapshot {
    return getOrderBookSnapshot(this.state, depth);
  }

  public getState(): MatchingState {
    return copyState(this.state);
  }

  private existingCommandResult(command: MatchingCommand): readonly MatchingEvent[] | undefined {
    if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
      return undefined;
    }
    return this.state.commandResults.get(command.commandId)?.events;
  }

  private existingClientOrderResult(command: PlaceCommand): readonly MatchingEvent[] | undefined {
    if (
      typeof command.participantId !== 'string' ||
      command.participantId.length === 0 ||
      typeof command.clientOrderId !== 'string' ||
      command.clientOrderId.length === 0
    ) {
      return undefined;
    }
    const originalCommandId = this.state.clientOrderIndex.get(
      clientOrderKey(command.participantId, command.clientOrderId),
    );
    return originalCommandId === undefined
      ? undefined
      : this.state.commandResults.get(originalCommandId)?.events;
  }

  private place(command: PlaceCommand, sequence: bigint): readonly DraftEvent[] {
    const rejection = this.validatePlace(command);
    if (rejection !== undefined) {
      return [rejection];
    }

    const price = command.price!;
    const events: DraftEvent[] = [
      {
        type: 'OrderAccepted',
        orderId: command.orderId,
        participantId: command.participantId,
        clientOrderId: command.clientOrderId,
        instrumentId: command.instrumentId,
        side: command.side,
        orderType: 'LIMIT',
        price,
        quantity: command.quantity,
      },
    ];
    let remaining = command.quantity;
    let tradeOrdinal = 0;
    const oppositeSide = command.side === 'BUY' ? 'SELL' : 'BUY';

    for (const maker of openOrders(this.state, oppositeSide)) {
      if (remaining === 0n || !pricesCross(command.side, price, maker.price)) {
        break;
      }
      if (maker.participantId === command.participantId) {
        events.push({
          type: 'OrderCancelled',
          orderId: command.orderId,
          participantId: command.participantId,
          cancelledQuantity: remaining,
          reason: 'SELF_TRADE_PREVENTED',
        });
        break;
      }

      const executionQuantity = minimum(remaining, maker.openQuantity);
      tradeOrdinal += 1;
      events.push({
        type: 'TradeExecuted',
        tradeId: `trade:${this.config.instrumentId}:${sequence}:${tradeOrdinal}`,
        instrumentId: this.config.instrumentId,
        makerOrderId: maker.orderId,
        takerOrderId: command.orderId,
        buyOrderId: command.side === 'BUY' ? command.orderId : maker.orderId,
        sellOrderId: command.side === 'SELL' ? command.orderId : maker.orderId,
        price: maker.price,
        quantity: executionQuantity,
      });
      remaining -= executionQuantity;
    }

    return events;
  }

  private cancel(command: CancelCommand): readonly DraftEvent[] {
    const commonRejection = validateCommandIdentity(command);
    if (commonRejection !== undefined) {
      return [rejectCancel(command, commonRejection.reason, commonRejection.message)];
    }
    const order = this.state.ordersById.get(command.orderId);
    if (order === undefined) {
      return [rejectCancel(command, 'ORDER_NOT_FOUND', `Order ${command.orderId} was not found`)];
    }
    if (order.participantId !== command.participantId) {
      return [
        rejectCancel(
          command,
          'ORDER_NOT_OWNED',
          `Order ${command.orderId} does not belong to participant ${command.participantId}`,
        ),
      ];
    }
    if (order.openQuantity === 0n || !isOpenStatus(order.status)) {
      return [
        rejectCancel(
          command,
          'ORDER_NOT_CANCELLABLE',
          `Order ${command.orderId} has no cancellable open remainder`,
        ),
      ];
    }
    return [
      {
        type: 'OrderCancelled',
        orderId: order.orderId,
        participantId: order.participantId,
        cancelledQuantity: order.openQuantity,
        reason: 'USER_REQUESTED',
      },
    ];
  }

  private validatePlace(command: PlaceCommand): DraftRejected | undefined {
    const identityRejection = validateCommandIdentity(command);
    if (identityRejection !== undefined) {
      return rejectPlace(command, identityRejection.reason, identityRejection.message);
    }
    if (typeof command.clientOrderId !== 'string' || command.clientOrderId.length === 0) {
      return rejectPlace(command, 'INVALID_COMMAND', 'clientOrderId must be a non-empty string');
    }
    if (command.instrumentId !== this.config.instrumentId) {
      return rejectPlace(
        command,
        'INSTRUMENT_MISMATCH',
        `Expected instrument ${this.config.instrumentId}`,
      );
    }
    if (command.side !== 'BUY' && command.side !== 'SELL') {
      return rejectPlace(command, 'INVALID_COMMAND', 'side must be BUY or SELL');
    }
    if (command.type !== 'LIMIT') {
      return rejectPlace(command, 'ORDER_TYPE_NOT_AVAILABLE', 'Only LIMIT orders are available');
    }
    if (typeof command.price !== 'bigint' || command.price <= 0n) {
      return rejectPlace(command, 'PRICE_NOT_POSITIVE', 'price must be a positive bigint');
    }
    if (typeof command.quantity !== 'bigint' || command.quantity <= 0n) {
      return rejectPlace(command, 'QUANTITY_NOT_POSITIVE', 'quantity must be a positive bigint');
    }
    if (command.price % this.config.tickSize !== 0n) {
      return rejectPlace(command, 'PRICE_NOT_ON_TICK', 'price is not aligned to tickSize');
    }
    if (command.quantity % this.config.lotSize !== 0n) {
      return rejectPlace(command, 'QUANTITY_NOT_ON_LOT', 'quantity is not aligned to lotSize');
    }
    if (this.state.ordersById.has(command.orderId)) {
      return rejectPlace(command, 'DUPLICATE_ORDER_ID', `Order ${command.orderId} already exists`);
    }
    return undefined;
  }

  private readClock(): string {
    const occurredAt = this.config.clock();
    if (typeof occurredAt !== 'string' || !isIsoTimestamp(occurredAt)) {
      throw new TypeError('clock must return an ISO-8601 timestamp');
    }
    return occurredAt;
  }
}

function finalizeEvents(
  instrumentId: string,
  commandId: string,
  sequence: bigint,
  firstNonce: bigint,
  occurredAt: string,
  drafts: readonly DraftEvent[],
): readonly MatchingEvent[] {
  if (drafts.length === 0) {
    throw new Error('Every new command must produce at least one event');
  }
  return drafts.map((draft, index) => {
    const nonce = firstNonce + BigInt(index);
    return {
      ...draft,
      eventId: eventId(instrumentId, nonce),
      nonce,
      exchangeSequenceNumber: sequence,
      eventIndex: index,
      eventCount: drafts.length,
      commandId,
      occurredAt,
    } as MatchingEvent;
  });
}

function validateCommandIdentity(
  command: Pick<MatchingCommand, 'commandId' | 'orderId' | 'participantId'>,
): { readonly reason: 'INVALID_COMMAND'; readonly message: string } | undefined {
  if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
    return { reason: 'INVALID_COMMAND', message: 'commandId must be a non-empty string' };
  }
  if (typeof command.orderId !== 'string' || command.orderId.length === 0) {
    return { reason: 'INVALID_COMMAND', message: 'orderId must be a non-empty string' };
  }
  if (typeof command.participantId !== 'string' || command.participantId.length === 0) {
    return { reason: 'INVALID_COMMAND', message: 'participantId must be a non-empty string' };
  }
  return undefined;
}

function rejectPlace(
  command: PlaceCommand,
  reason: OrderRejectedEvent['reason'],
  message: string,
): DraftRejected {
  return {
    type: 'OrderRejected',
    participantId:
      typeof command.participantId === 'string' && command.participantId.length > 0
        ? command.participantId
        : 'UNKNOWN',
    reason,
    message,
    ...(typeof command.orderId === 'string' && command.orderId.length > 0
      ? { orderId: command.orderId }
      : {}),
    ...(typeof command.clientOrderId === 'string' && command.clientOrderId.length > 0
      ? { clientOrderId: command.clientOrderId }
      : {}),
    ...(typeof command.quantity === 'bigint' && command.quantity > 0n
      ? { rejectedQuantity: command.quantity }
      : {}),
  };
}

function rejectCancel(
  command: CancelCommand,
  reason: OrderRejectedEvent['reason'],
  message: string,
): DraftRejected {
  return {
    type: 'OrderRejected',
    participantId:
      typeof command.participantId === 'string' && command.participantId.length > 0
        ? command.participantId
        : 'UNKNOWN',
    reason,
    message,
    ...(typeof command.orderId === 'string' && command.orderId.length > 0
      ? { orderId: command.orderId }
      : {}),
  };
}

function pricesCross(side: PlaceCommand['side'], takerPrice: bigint, makerPrice: bigint): boolean {
  return side === 'BUY' ? takerPrice >= makerPrice : takerPrice <= makerPrice;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function isOpenStatus(status: EngineOrder['status']): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function copyState(state: MatchingState): MatchingState {
  return {
    ...state,
    ordersById: new Map(
      [...state.ordersById].map(([orderId, order]) => [
        orderId,
        { ...order, tradeIds: [...order.tradeIds] },
      ]),
    ),
    clientOrderIndex: new Map(state.clientOrderIndex),
    commandResults: new Map(
      [...state.commandResults].map(([commandId, result]) => [
        commandId,
        { ...result, events: [...result.events] },
      ]),
    ),
    events: [...state.events],
  };
}

export type OrderSide = 'BUY' | 'SELL';
export type SubmittedOrderType = 'LIMIT' | 'MARKET';
export type SelfTradePolicy = 'CANCEL_NEWEST';

export type OrderStatus =
  | 'NEW'
  | 'VALIDATING'
  | 'ACCEPTED'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'REJECTED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'EXPIRED';

export type OrderRejectionReason =
  | 'INVALID_COMMAND'
  | 'INSTRUMENT_MISMATCH'
  | 'ORDER_TYPE_NOT_AVAILABLE'
  | 'PRICE_NOT_POSITIVE'
  | 'QUANTITY_NOT_POSITIVE'
  | 'PRICE_NOT_ON_TICK'
  | 'QUANTITY_NOT_ON_LOT'
  | 'DUPLICATE_ORDER_ID'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_OWNED'
  | 'ORDER_NOT_CANCELLABLE';

export type CancellationReason = 'USER_REQUESTED' | 'SELF_TRADE_PREVENTED';

export interface PlaceCommand {
  readonly kind: 'PLACE';
  readonly commandId: string;
  readonly orderId: string;
  readonly participantId: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: OrderSide;
  readonly type: SubmittedOrderType;
  readonly price?: bigint;
  readonly quantity: bigint;
}

export interface CancelCommand {
  readonly kind: 'CANCEL';
  readonly commandId: string;
  readonly orderId: string;
  readonly participantId: string;
}

export type MatchingCommand = PlaceCommand | CancelCommand;

export interface MatchingEventBase {
  readonly eventId: string;
  readonly nonce: bigint;
  readonly exchangeSequenceNumber: bigint;
  readonly eventIndex: number;
  readonly eventCount: number;
  readonly commandId: string;
  readonly occurredAt: string;
}

export interface OrderAcceptedEvent extends MatchingEventBase {
  readonly type: 'OrderAccepted';
  readonly orderId: string;
  readonly participantId: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: OrderSide;
  readonly orderType: 'LIMIT';
  readonly price: bigint;
  readonly quantity: bigint;
}

export interface OrderRejectedEvent extends MatchingEventBase {
  readonly type: 'OrderRejected';
  readonly participantId: string;
  readonly reason: OrderRejectionReason;
  readonly message: string;
  readonly orderId?: string;
  readonly clientOrderId?: string;
  readonly rejectedQuantity?: bigint;
}

export interface TradeExecutedEvent extends MatchingEventBase {
  readonly type: 'TradeExecuted';
  readonly tradeId: string;
  readonly instrumentId: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly price: bigint;
  readonly quantity: bigint;
}

export interface OrderCancelledEvent extends MatchingEventBase {
  readonly type: 'OrderCancelled';
  readonly orderId: string;
  readonly participantId: string;
  readonly cancelledQuantity: bigint;
  readonly reason: CancellationReason;
}

export interface OrderExpiredEvent extends MatchingEventBase {
  readonly type: 'OrderExpired';
  readonly orderId: string;
  readonly expiredQuantity: bigint;
}

export type MatchingEvent =
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | TradeExecutedEvent
  | OrderCancelledEvent
  | OrderExpiredEvent;

export interface EngineOrder {
  readonly orderId: string;
  readonly participantId: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: OrderSide;
  readonly type: 'LIMIT';
  readonly price: bigint;
  readonly quantity: bigint;
  readonly openQuantity: bigint;
  readonly status: OrderStatus;
  readonly acceptedSequence: bigint;
  readonly tradeIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
}

export interface CommandResult {
  readonly commandId: string;
  readonly exchangeSequenceNumber: bigint;
  readonly events: readonly MatchingEvent[];
}

export interface MatchingState {
  readonly instrumentId: string;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly selfTradePolicy: SelfTradePolicy;
  readonly nextExchangeSequenceNumber: bigint;
  readonly nextEventNonce: bigint;
  readonly lastEventAt: string;
  readonly ordersById: ReadonlyMap<string, EngineOrder>;
  readonly clientOrderIndex: ReadonlyMap<string, string>;
  readonly commandResults: ReadonlyMap<string, CommandResult>;
  readonly events: readonly MatchingEvent[];
}

export interface OrderBookLevel {
  readonly price: bigint;
  readonly quantity: bigint;
  readonly orderCount: number;
}

export interface OrderBookSnapshot {
  readonly instrumentId: string;
  readonly sequence: bigint;
  readonly snapshotAt: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
}

export interface EngineConfig {
  readonly instrumentId: string;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly selfTradePolicy: SelfTradePolicy;
  readonly clock: () => string;
}

export type ReplayConfig = Omit<EngineConfig, 'clock'>;

export interface MatchingEngineApi {
  submitCommand(command: MatchingCommand): readonly MatchingEvent[];
  getOrderBook(depth: number): OrderBookSnapshot;
  getState(): MatchingState;
}

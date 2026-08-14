import type { OrderSide, SubmittedOrderType } from '@commodity-chain/matching-core';

export interface PlaceOrderCommand {
  readonly participantId: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: OrderSide;
  readonly type: SubmittedOrderType;
  readonly price?: bigint;
  readonly quantity: bigint;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface CancelOrderCommand {
  readonly participantId: string;
  readonly orderId: string;
  readonly correlationId: string;
}

export interface OrderView {
  readonly id: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: OrderSide;
  readonly type: SubmittedOrderType;
  readonly price?: string;
  readonly quantity: string;
  readonly openQuantity: string;
  readonly status: string;
  readonly feeScheduleVersion: number;
  readonly trades: readonly TradeView[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt?: string;
  readonly closedAt?: string;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface TradeView {
  readonly tradeId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly instrumentId: string;
  readonly price: string;
  readonly quantity: string;
  readonly executedAt: string;
  readonly settlement: SettlementView;
}

export interface SettlementView {
  readonly tradeId: string;
  readonly cashLeg: {
    readonly currency: string;
    readonly amount: string;
    readonly payer: string;
    readonly payee: string;
  };
  readonly tokenLeg: {
    readonly instrumentId: string;
    readonly quantity: string;
    readonly unit: string;
    readonly from: string;
    readonly to: string;
  };
  readonly fees: readonly {
    readonly feeType: string;
    readonly currency: string;
    readonly amount: string;
  }[];
  readonly finalityStatus: string;
  readonly updatedAt: string;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface OmsErrorBody {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly details: readonly {
    readonly field?: string;
    readonly reason: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }[];
}

export interface OmsExecutionResult {
  readonly httpStatus: number;
  readonly replayed: boolean;
  readonly body: OrderView | OmsErrorBody;
}

export interface OrderBookView {
  readonly instrumentId: string;
  readonly sequence: string;
  readonly snapshotAt: string;
  readonly bids: readonly {
    readonly price: string;
    readonly quantity: string;
    readonly orderCount: number;
  }[];
  readonly asks: readonly {
    readonly price: string;
    readonly quantity: string;
    readonly orderCount: number;
  }[];
}

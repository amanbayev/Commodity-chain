import type { MatchingEvent } from '@commodity-chain/matching-core';

export function serializeMatchingEvent(event: MatchingEvent): Readonly<Record<string, unknown>> {
  return JSON.parse(
    JSON.stringify(event, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Readonly<Record<string, unknown>>;
}

export function deserializeMatchingEvent(value: unknown): MatchingEvent {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new TypeError('Persisted matching event is not an object');
  }
  const base = {
    eventId: stringField(value, 'eventId'),
    nonce: bigintField(value, 'nonce'),
    exchangeSequenceNumber: bigintField(value, 'exchangeSequenceNumber'),
    eventIndex: integerField(value, 'eventIndex'),
    eventCount: integerField(value, 'eventCount'),
    commandId: stringField(value, 'commandId'),
    occurredAt: stringField(value, 'occurredAt'),
  };
  switch (value['type']) {
    case 'OrderAccepted':
      return {
        ...base,
        type: 'OrderAccepted',
        orderId: stringField(value, 'orderId'),
        participantId: stringField(value, 'participantId'),
        clientOrderId: stringField(value, 'clientOrderId'),
        instrumentId: stringField(value, 'instrumentId'),
        side: enumField(value, 'side', ['BUY', 'SELL']),
        orderType: enumField(value, 'orderType', ['LIMIT']),
        price: bigintField(value, 'price'),
        quantity: bigintField(value, 'quantity'),
      };
    case 'OrderRejected':
      return {
        ...base,
        type: 'OrderRejected',
        participantId: stringField(value, 'participantId'),
        reason: enumField(value, 'reason', [
          'INVALID_COMMAND',
          'INSTRUMENT_MISMATCH',
          'ORDER_TYPE_NOT_AVAILABLE',
          'PRICE_NOT_POSITIVE',
          'QUANTITY_NOT_POSITIVE',
          'PRICE_NOT_ON_TICK',
          'QUANTITY_NOT_ON_LOT',
          'DUPLICATE_ORDER_ID',
          'ORDER_NOT_FOUND',
          'ORDER_NOT_OWNED',
          'ORDER_NOT_CANCELLABLE',
        ]),
        message: stringField(value, 'message'),
        ...optionalString(value, 'orderId'),
        ...optionalString(value, 'clientOrderId'),
        ...(value['rejectedQuantity'] === undefined
          ? {}
          : { rejectedQuantity: bigintField(value, 'rejectedQuantity') }),
      };
    case 'TradeExecuted':
      return {
        ...base,
        type: 'TradeExecuted',
        tradeId: stringField(value, 'tradeId'),
        instrumentId: stringField(value, 'instrumentId'),
        makerOrderId: stringField(value, 'makerOrderId'),
        takerOrderId: stringField(value, 'takerOrderId'),
        buyOrderId: stringField(value, 'buyOrderId'),
        sellOrderId: stringField(value, 'sellOrderId'),
        price: bigintField(value, 'price'),
        quantity: bigintField(value, 'quantity'),
      };
    case 'OrderCancelled':
      return {
        ...base,
        type: 'OrderCancelled',
        orderId: stringField(value, 'orderId'),
        participantId: stringField(value, 'participantId'),
        cancelledQuantity: bigintField(value, 'cancelledQuantity'),
        reason: enumField(value, 'reason', ['USER_REQUESTED', 'SELF_TRADE_PREVENTED']),
      };
    case 'OrderExpired':
      return {
        ...base,
        type: 'OrderExpired',
        orderId: stringField(value, 'orderId'),
        expiredQuantity: bigintField(value, 'expiredQuantity'),
      };
    default:
      throw new TypeError(`Unknown matching event type ${String(value['type'])}`);
  }
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  return value[key] === undefined ? {} : { [key]: stringField(value, key) };
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) throw new TypeError(`${key} is invalid`);
  return field;
}

function bigintField(value: Readonly<Record<string, unknown>>, key: string): bigint {
  const field = value[key];
  if (typeof field !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(field)) {
    throw new TypeError(`${key} is not a non-negative integer string`);
  }
  return BigInt(field);
}

function integerField(value: Readonly<Record<string, unknown>>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field)) throw new TypeError(`${key} is not a safe integer`);
  return field as number;
}

function enumField<const T extends string>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T {
  const field = value[key];
  if (typeof field !== 'string' || !allowed.includes(field as T)) {
    throw new TypeError(`${key} is invalid`);
  }
  return field as T;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

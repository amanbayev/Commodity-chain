import type { components } from '../../../api/generated/schema.js';
import type { ApiClient } from '../../../api/client.js';

export type InstrumentMarketItem = components['schemas']['InstrumentMarketItem'];
export type InstrumentMarketPage = components['schemas']['InstrumentMarketPage'];
export type InstrumentPassport = components['schemas']['InstrumentPassport'];
export type OrderBook = components['schemas']['OrderBook'];
export type Order = components['schemas']['Order'];
export type OrderPage = components['schemas']['OrderPage'];
export type OrderCreateRequest = components['schemas']['OrderCreateRequest'];

export async function fetchMarketInstruments(client: ApiClient): Promise<InstrumentMarketPage> {
  return (
    await client.request<InstrumentMarketPage, '/instruments', 'get'>({
      method: 'GET',
      path: '/instruments',
      query: { limit: 200 },
    })
  ).data;
}

export async function fetchInstrumentPassport(
  client: ApiClient,
  instrumentId: string,
): Promise<InstrumentPassport> {
  return (
    await client.request<InstrumentPassport, '/instruments/{id}/passport', 'get'>({
      method: 'GET',
      path: '/instruments/{id}/passport',
      pathParameters: { id: instrumentId },
    })
  ).data;
}

export async function fetchOrderBook(client: ApiClient, instrumentId: string): Promise<OrderBook> {
  return (
    await client.request<OrderBook, '/orderbook/{instrumentId}', 'get'>({
      method: 'GET',
      path: '/orderbook/{instrumentId}',
      pathParameters: { instrumentId },
      query: { depth: 20 },
    })
  ).data;
}

export async function fetchParticipantOrders(
  client: ApiClient,
  participantId: string,
): Promise<OrderPage> {
  return (
    await client.request<OrderPage, '/orders', 'get'>({
      headers: { 'X-Participant-Id': participantId },
      method: 'GET',
      path: '/orders',
      query: { limit: 200 },
    })
  ).data;
}

export async function submitOrder(
  client: ApiClient,
  participantId: string,
  idempotencyKey: string,
  order: OrderCreateRequest,
): Promise<Order> {
  return (
    await client.request<Order, '/orders', 'post', OrderCreateRequest>({
      body: order,
      headers: { 'X-Participant-Id': participantId },
      idempotencyKey,
      method: 'POST',
      path: '/orders',
    })
  ).data;
}

export async function cancelOrder(
  client: ApiClient,
  participantId: string,
  orderId: string,
): Promise<Order> {
  return (
    await client.request<Order, '/orders/{id}', 'delete'>({
      headers: { 'X-Participant-Id': participantId },
      method: 'DELETE',
      path: '/orders/{id}',
      pathParameters: { id: orderId },
    })
  ).data;
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../../../api/useApi.js';
import { useAuth } from '../../../auth/AuthProvider.js';
import {
  cancelOrder,
  fetchInstrumentPassport,
  fetchMarketInstruments,
  fetchOrderBook,
  fetchParticipantOrders,
  submitOrder,
  type OrderCreateRequest,
} from './investorApi.js';

export const investorQueryKeys = {
  market: ['investor', 'market'] as const,
  orders: (participantId: string) => ['investor', 'orders', participantId] as const,
  orderBook: (instrumentId: string) => ['investor', 'orderbook', instrumentId] as const,
  passport: (instrumentId: string) => ['investor', 'passport', instrumentId] as const,
};

export function useMarketInstruments() {
  const client = useApi();
  return useQuery({
    queryFn: () => fetchMarketInstruments(client),
    queryKey: investorQueryKeys.market,
  });
}

export function useInstrumentPassport(instrumentId: string) {
  const client = useApi();
  return useQuery({
    enabled: instrumentId.length > 0,
    queryFn: () => fetchInstrumentPassport(client, instrumentId),
    queryKey: investorQueryKeys.passport(instrumentId),
  });
}

export function useOrderBook(instrumentId: string) {
  const client = useApi();
  return useQuery({
    enabled: instrumentId.length > 0,
    queryFn: () => fetchOrderBook(client, instrumentId),
    queryKey: investorQueryKeys.orderBook(instrumentId),
    refetchInterval: 5_000,
  });
}

export function useParticipantOrders() {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    queryFn: () => fetchParticipantOrders(client, session.participantId),
    queryKey: investorQueryKeys.orders(session.participantId),
  });
}

export function useSubmitOrder() {
  const client = useApi();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: ({
      idempotencyKey,
      order,
    }: {
      idempotencyKey: string;
      order: OrderCreateRequest;
    }) => submitOrder(client, session.participantId, idempotencyKey, order),
    onSuccess: async (order) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: investorQueryKeys.orders(session.participantId),
        }),
        queryClient.invalidateQueries({
          queryKey: investorQueryKeys.orderBook(order.instrumentId),
        }),
        queryClient.invalidateQueries({ queryKey: investorQueryKeys.market }),
      ]);
    },
  });
}

export function useCancelOrder() {
  const client = useApi();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: (orderId: string) => cancelOrder(client, session.participantId, orderId),
    onSuccess: async (order) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: investorQueryKeys.orders(session.participantId),
        }),
        queryClient.invalidateQueries({
          queryKey: investorQueryKeys.orderBook(order.instrumentId),
        }),
        queryClient.invalidateQueries({ queryKey: investorQueryKeys.market }),
      ]);
    },
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../api/useApi.js';
import { useAuth } from '../../../auth/AuthProvider.js';
import {
  confirmShipment,
  fetchElevatorDashboard,
  fetchShipment,
  fetchVerification,
  reserveVerification,
} from './elevatorApi.js';

const keys = {
  dashboard: (id: string) => ['elevator', id, 'dashboard'] as const,
  shipment: (id: string, redemptionId: string) =>
    ['elevator', id, 'shipment', redemptionId] as const,
  verification: (id: string, requestId: string) =>
    ['elevator', id, 'verification', requestId] as const,
};

export function useElevatorDashboard() {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    queryKey: keys.dashboard(session.participantId),
    queryFn: () => fetchElevatorDashboard(client, session.participantId),
  });
}

export function useVerification(requestId: string) {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    enabled: requestId.length > 0,
    queryKey: keys.verification(session.participantId, requestId),
    queryFn: () => fetchVerification(client, session.participantId, requestId),
  });
}

export function useReserveVerification(requestId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: () => reserveVerification(client, session.participantId, requestId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.dashboard(session.participantId) }),
        queryClient.invalidateQueries({
          queryKey: keys.verification(session.participantId, requestId),
        }),
      ]);
    },
  });
}

export function useShipment(redemptionId: string) {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    enabled: redemptionId.length > 0,
    queryKey: keys.shipment(session.participantId, redemptionId),
    queryFn: () => fetchShipment(client, session.participantId, redemptionId),
  });
}

export function useConfirmShipment(redemptionId: string) {
  const client = useApi();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: () => confirmShipment(client, session.participantId, redemptionId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.dashboard(session.participantId) }),
        queryClient.invalidateQueries({
          queryKey: keys.shipment(session.participantId, redemptionId),
        }),
      ]);
    },
  });
}

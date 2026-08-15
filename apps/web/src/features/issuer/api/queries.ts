import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../../../api/useApi.js';
import { useAuth } from '../../../auth/AuthProvider.js';
import {
  createInstrumentDraft,
  fetchInstrumentCollateral,
  fetchIssuerInstrument,
  fetchIssuerInstruments,
  submitInstrument,
  updateInstrumentDraft,
  type InstrumentDraftCreate,
  type InstrumentDraftUpdate,
} from './issuerApi.js';

const keys = {
  all: (actorId: string) => ['issuer', actorId, 'issues'] as const,
  collateral: (actorId: string, id: string) => ['issuer', actorId, id, 'collateral'] as const,
  issue: (actorId: string, id: string) => ['issuer', actorId, id] as const,
};

export function useIssuerInstruments() {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    queryKey: keys.all(session.participantId),
    queryFn: () => fetchIssuerInstruments(client, session.participantId),
  });
}

export function useIssuerInstrument(id: string) {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    enabled: id.length > 0,
    queryKey: keys.issue(session.participantId, id),
    queryFn: () => fetchIssuerInstrument(client, session.participantId, id),
  });
}

export function useInstrumentCollateral(id: string) {
  const client = useApi();
  const { session } = useAuth();
  return useQuery({
    enabled: id.length > 0,
    queryKey: keys.collateral(session.participantId, id),
    queryFn: () => fetchInstrumentCollateral(client, session.participantId, id),
  });
}

export function useDraftCommands() {
  const client = useApi();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const refresh = async (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.all(session.participantId) }),
      queryClient.invalidateQueries({ queryKey: keys.issue(session.participantId, id) }),
    ]);
  const create = useMutation({
    mutationFn: (draft: InstrumentDraftCreate) =>
      createInstrumentDraft(client, session.participantId, draft),
    onSuccess: (result) => refresh(result.instrument.id),
  });
  const update = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: InstrumentDraftUpdate }) =>
      updateInstrumentDraft(client, session.participantId, id, draft),
    onSuccess: (result) => refresh(result.instrument.id),
  });
  const submit = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      submitInstrument(client, session.participantId, id, version),
    onSuccess: (result) => refresh(result.instrument.id),
  });
  return { create, submit, update };
}

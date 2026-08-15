import type { ApiClient } from '../../../api/client.js';
import type { components } from '../../../api/generated/schema.js';

export type InstrumentDraftCreate = components['schemas']['InstrumentDraftCreate'];
export type InstrumentDraftUpdate = components['schemas']['InstrumentDraftUpdate'];
export type InstrumentDraft = components['schemas']['InstrumentDraft'];
export type InstrumentSubmissionResult = components['schemas']['InstrumentSubmissionResult'];
export type IssuerInstrument = components['schemas']['IssuerInstrument'];
export type IssuerInstrumentSummary = components['schemas']['IssuerInstrumentSummary'];
export type IssuerInstrumentPage = components['schemas']['IssuerInstrumentPage'];
export type CollateralSummary = components['schemas']['CollateralSummary'];

const actorHeaders = (actorId: string) => ({ 'X-Actor-Id': actorId });

export async function createInstrumentDraft(
  client: ApiClient,
  actorId: string,
  draft: InstrumentDraftCreate,
): Promise<InstrumentDraft> {
  return (
    await client.request<InstrumentDraft, '/instruments/drafts', 'post', InstrumentDraftCreate>({
      body: draft,
      headers: actorHeaders(actorId),
      method: 'POST',
      path: '/instruments/drafts',
    })
  ).data;
}

export async function updateInstrumentDraft(
  client: ApiClient,
  actorId: string,
  instrumentId: string,
  draft: InstrumentDraftUpdate,
): Promise<InstrumentDraft> {
  return (
    await client.request<
      InstrumentDraft,
      '/instruments/{id}/draft',
      'patch',
      InstrumentDraftUpdate
    >({
      body: draft,
      headers: actorHeaders(actorId),
      method: 'PATCH',
      path: '/instruments/{id}/draft',
      pathParameters: { id: instrumentId },
    })
  ).data;
}

export async function submitInstrument(
  client: ApiClient,
  actorId: string,
  instrumentId: string,
  version: number,
): Promise<InstrumentSubmissionResult> {
  return (
    await client.request<
      InstrumentSubmissionResult,
      '/instruments/{id}/submit',
      'post',
      { version: number }
    >({
      body: { version },
      headers: actorHeaders(actorId),
      method: 'POST',
      path: '/instruments/{id}/submit',
      pathParameters: { id: instrumentId },
    })
  ).data;
}

export async function fetchIssuerInstruments(
  client: ApiClient,
  actorId: string,
): Promise<IssuerInstrumentPage> {
  return (
    await client.request<IssuerInstrumentPage, '/instruments/issues', 'get'>({
      headers: actorHeaders(actorId),
      method: 'GET',
      path: '/instruments/issues',
      query: { limit: 200 },
    })
  ).data;
}

export async function fetchIssuerInstrument(
  client: ApiClient,
  actorId: string,
  instrumentId: string,
): Promise<IssuerInstrument> {
  return (
    await client.request<IssuerInstrument, '/instruments/{id}/issue', 'get'>({
      headers: actorHeaders(actorId),
      method: 'GET',
      path: '/instruments/{id}/issue',
      pathParameters: { id: instrumentId },
    })
  ).data;
}

export async function fetchInstrumentCollateral(
  client: ApiClient,
  actorId: string,
  instrumentId: string,
): Promise<CollateralSummary> {
  return (
    await client.request<CollateralSummary, '/instruments/{id}/collateral', 'get'>({
      headers: actorHeaders(actorId),
      method: 'GET',
      path: '/instruments/{id}/collateral',
      pathParameters: { id: instrumentId },
    })
  ).data;
}

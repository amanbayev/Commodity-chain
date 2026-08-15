import type { paths } from './generated/schema.js';
import { ApiError, isApiErrorResponse } from './errors.js';

type HttpMethod = 'delete' | 'get' | 'patch' | 'post' | 'put';
export type ApiPath = keyof paths;
export type ApiMethodForPath<Path extends ApiPath> = Extract<keyof paths[Path], HttpMethod>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  getAccessToken?: () => string | null;
  onError?: (error: ApiError) => void;
}

export interface ApiRequest<Path extends ApiPath, Method extends ApiMethodForPath<Path>, Body> {
  body?: Body;
  correlationId?: string;
  headers?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  method: Uppercase<Method>;
  path: Path;
  pathParameters?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, boolean | number | string | undefined>>;
}

export interface ApiResult<Response> {
  correlationId: string;
  data: Response;
  idempotencyReplayed: boolean;
  status: number;
}

function expandPath(path: string, parameters: Readonly<Record<string, string>>): string {
  return path.replaceAll(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = parameters[key];
    if (value === undefined) throw new Error(`Missing path parameter: ${key}`);
    return encodeURIComponent(value);
  });
}

function buildQuery(query: ApiRequest<ApiPath, never, unknown>['query']): string {
  if (query === undefined) return '';
  const entries = Object.entries(query).filter(
    (entry): entry is [string, boolean | number | string] => entry[1] !== undefined,
  );
  if (entries.length === 0) return '';
  const params = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]));
  return `?${params.toString()}`;
}

export function createApiClient({
  baseUrl = '/v1',
  fetchImplementation = fetch,
  getAccessToken = () => null,
  onError,
}: ApiClientOptions = {}) {
  return {
    async request<
      Response,
      Path extends ApiPath,
      Method extends ApiMethodForPath<Path>,
      Body = never,
    >(request: ApiRequest<Path, Method, Body>): Promise<ApiResult<Response>> {
      const correlationId = request.correlationId ?? globalThis.crypto.randomUUID();
      const headers = new Headers({
        Accept: 'application/json',
        'X-Correlation-Id': correlationId,
      });
      const accessToken = getAccessToken();
      if (accessToken !== null) headers.set('Authorization', `Bearer ${accessToken}`);
      if (request.idempotencyKey !== undefined)
        headers.set('Idempotency-Key', request.idempotencyKey);
      for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
      if (request.body !== undefined) headers.set('Content-Type', 'application/json');

      const url = `${baseUrl}${expandPath(request.path, request.pathParameters ?? {})}${buildQuery(request.query)}`;
      const requestInit: RequestInit = { headers, method: request.method };
      if (request.body !== undefined) requestInit.body = JSON.stringify(request.body);
      const response = await fetchImplementation(url, requestInit);
      const responseCorrelationId = response.headers.get('X-Correlation-Id') ?? correlationId;
      const payload: unknown = response.status === 204 ? undefined : await response.json();

      if (!response.ok) {
        const errorPayload = isApiErrorResponse(payload)
          ? payload
          : {
              code: 'INTERNAL_ERROR' as const,
              correlationId: responseCorrelationId,
              details: [],
              message: `Unexpected API response (${response.status})`,
            };
        const error = new ApiError(errorPayload, response.status);
        onError?.(error);
        throw error;
      }

      return {
        correlationId: responseCorrelationId,
        data: payload as Response,
        idempotencyReplayed: response.headers.get('Idempotency-Replayed') === 'true',
        status: response.status,
      };
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

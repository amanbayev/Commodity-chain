import type {
  OracleEventEnvelope,
  OracleEventPublisher,
  OracleEventReceipt,
  OraclePublishContext,
} from '../ezr-registry/types.js';
import { EzrRegistryError } from '../ezr-registry/types.js';
import { signatureHeader } from './signing.js';

export interface HttpOracleEventPublisherOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
}

export class HttpOracleEventPublisher implements OracleEventPublisher {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: HttpOracleEventPublisherOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  public async publish(
    envelope: OracleEventEnvelope,
    context: OraclePublishContext,
  ): Promise<OracleEventReceipt> {
    const response = await this.fetchImplementation(
      `${this.options.baseUrl.replace(/\/$/u, '')}/v1/oracle-events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.bearerToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': context.idempotencyKey,
          'X-Correlation-Id': context.correlationId,
          'X-Oracle-Signature': signatureHeader(envelope.signature),
        },
        body: JSON.stringify(envelope),
      },
    );

    const body: unknown = await response.json();
    if (!response.ok) {
      throw new EzrRegistryError(
        'DELIVERY_FAILED',
        `Oracle gateway rejected event ${envelope.eventId} with HTTP ${response.status}`,
      );
    }
    if (!isOracleEventReceipt(body)) {
      throw new EzrRegistryError('DELIVERY_FAILED', 'Oracle gateway returned an invalid receipt');
    }

    return body;
  }
}

function isOracleEventReceipt(value: unknown): value is OracleEventReceipt {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.eventId === 'string' &&
    typeof candidate.acceptedAt === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.replayed === 'boolean'
  );
}

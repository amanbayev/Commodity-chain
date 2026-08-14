import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { AcceptOracleEventUseCase } from './accept-oracle-event.use-case.js';
import { canonicalOraclePayload } from './canonical-json.js';
import { Ed25519SignatureVerifier } from './ed25519-verifier.js';
import type {
  ApplyOracleEventInput,
  CompleteOracleEventInput,
  InsertReceivedInput,
  OracleEventRepository,
  OracleEventTransaction,
  StoredOracleEvent,
  TrustedSourceKey,
} from './oracle-event.repository.js';
import type {
  AcceptOracleEventCommand,
  AcceptOracleEventResult,
  OracleEventEnvelope,
  OracleProcessingStatus,
} from './oracle-event.types.js';
import { OpenApiOracleEnvelopeValidator } from './openapi-oracle-validator.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');

interface FakeStoredEvent {
  id: string;
  sourceId: string | null;
  eventId: string | null;
  status: OracleProcessingStatus;
  requestHash: Buffer;
  createdAt: string;
  httpStatus: AcceptOracleEventResult['httpStatus'] | null;
  responseBody: AcceptOracleEventResult['body'] | null;
  nonce: bigint | null;
  idempotencyKey: string;
}

class FakeRepository implements OracleEventRepository, OracleEventTransaction {
  public readonly events: FakeStoredEvent[] = [];
  public readonly transitions: string[] = [];
  public effects = 0;
  public trustedKey: TrustedSourceKey | null = null;
  private nextId = 1n;

  public async withTransaction<Result>(
    operation: (transaction: OracleEventTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  public async lockIdempotencyKey(): Promise<void> {}
  public async lockSource(): Promise<void> {}

  public async findByIdempotencyKey(key: string): Promise<StoredOracleEvent | null> {
    return this.events.find((event) => event.idempotencyKey === key) ?? null;
  }

  public async findBySourceEvent(
    sourceId: string,
    eventId: string,
  ): Promise<StoredOracleEvent | null> {
    return (
      this.events.find((event) => event.sourceId === sourceId && event.eventId === eventId) ?? null
    );
  }

  public async findAppliedByNonce(
    sourceId: string,
    nonce: bigint,
  ): Promise<StoredOracleEvent | null> {
    return (
      this.events.find(
        (event) =>
          event.sourceId === sourceId && event.nonce === nonce && event.status === 'APPLIED',
      ) ?? null
    );
  }

  public async lastAppliedNonce(sourceId: string): Promise<bigint> {
    return this.events
      .filter((event) => event.sourceId === sourceId && event.status === 'APPLIED')
      .reduce(
        (highest, event) => (event.nonce !== null && event.nonce > highest ? event.nonce : highest),
        0n,
      );
  }

  public async findTrustedKey(): Promise<TrustedSourceKey | null> {
    return this.trustedKey;
  }

  public async insertReceived(input: InsertReceivedInput): Promise<StoredOracleEvent> {
    const event: FakeStoredEvent = {
      id: String(this.nextId++),
      sourceId: input.sourceId,
      eventId: input.eventId,
      status: 'RECEIVED',
      requestHash: input.requestHash,
      createdAt: NOW.toISOString(),
      httpStatus: null,
      responseBody: null,
      nonce: null,
      idempotencyKey: input.idempotencyKey,
    };
    this.events.push(event);
    return event;
  }

  public async hydrateValidated(id: string, envelope: OracleEventEnvelope): Promise<void> {
    const event = this.requireEvent(id);
    event.nonce = BigInt(envelope.nonce);
  }

  public async transition(
    id: string,
    from: OracleProcessingStatus,
    to: OracleProcessingStatus,
  ): Promise<void> {
    const event = this.requireEvent(id);
    expect(event.status).toBe(from);
    event.status = to;
    this.transitions.push(`${from}->${to}`);
  }

  public async complete(input: CompleteOracleEventInput): Promise<void> {
    await this.transition(input.id, input.from, input.to);
    const event = this.requireEvent(input.id);
    event.httpStatus = input.result.httpStatus;
    event.responseBody = input.result.body;
  }

  public async apply(input: ApplyOracleEventInput): Promise<void> {
    await this.transition(input.stored.id, 'POLICY_VALIDATED', 'APPLIED');
    const event = this.requireEvent(input.stored.id);
    event.httpStatus = input.result.httpStatus;
    event.responseBody = input.result.body;
    this.effects += 1;
  }

  private requireEvent(id: string): FakeStoredEvent {
    const event = this.events.find((candidate) => candidate.id === id);
    if (event === undefined) {
      throw new Error(`Missing fake event ${id}`);
    }
    return event;
  }
}

describe('AcceptOracleEventUseCase', () => {
  let repository: FakeRepository;
  let privateKey: KeyObject;
  let publicKeyPem: string;
  let useCase: AcceptOracleEventUseCase;

  beforeEach(() => {
    repository = new FakeRepository();
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    repository.trustedKey = trustedKey(publicKeyPem);
    useCase = new AcceptOracleEventUseCase(
      repository,
      new OpenApiOracleEnvelopeValidator(),
      new Ed25519SignatureVerifier(),
      { now: () => NOW },
      { freshnessWindowMs: 24 * 60 * 60 * 1000 },
    );
  });

  it('moves a valid event through every state and applies one atomic effect', async () => {
    const result = await useCase.execute(signedCommand(privateKey));

    expect(result.status).toBe('APPLIED');
    expect(repository.transitions).toEqual([
      'RECEIVED->SCHEMA_VALIDATED',
      'SCHEMA_VALIDATED->SIGNATURE_VALIDATED',
      'SIGNATURE_VALIDATED->POLICY_VALIDATED',
      'POLICY_VALIDATED->APPLIED',
    ]);
    expect(repository.effects).toBe(1);
  });

  it('rejects an extra field at the schema boundary', async () => {
    const command = signedCommand(privateKey);
    const result = await useCase.execute({
      ...command,
      payload: { ...(command.payload as object), unexpected: true },
    });

    expect(result.status).toBe('REJECTED');
    expect(result.httpStatus).toBe(400);
    expect(repository.transitions).toEqual(['RECEIVED->REJECTED']);
  });

  it('rejects a tampered signature', async () => {
    const command = signedCommand(privateKey);
    const result = await useCase.execute({ ...command, detachedSignature: 'invalid' });

    expect(result.status).toBe('REJECTED');
    expect(errorCode(result)).toBe('ORACLE_SIGNATURE_INVALID');
    expect(repository.transitions.at(-1)).toBe('SCHEMA_VALIDATED->REJECTED');
  });

  it('rejects an unknown source key', async () => {
    repository.trustedKey = null;
    const result = await useCase.execute(signedCommand(privateKey));

    expect(errorCode(result)).toBe('ORACLE_SOURCE_UNKNOWN');
    expect(repository.events[0]?.status).toBe('REJECTED');
  });

  it('rejects a cryptographically valid signature from a revoked key', async () => {
    repository.trustedKey = { ...trustedKey(publicKeyPem), revokedAt: NOW.toISOString() };
    const result = await useCase.execute(signedCommand(privateKey));

    expect(errorCode(result)).toBe('ORACLE_SOURCE_KEY_REVOKED');
    expect(repository.effects).toBe(0);
  });

  it('marks a replayed nonce as duplicate without another effect', async () => {
    await useCase.execute(signedCommand(privateKey, { nonce: 1 }));
    const duplicate = await useCase.execute(
      signedCommand(privateKey, { eventId: randomUUID(), nonce: 1 }),
    );

    expect(duplicate.status).toBe('DUPLICATE');
    expect(duplicate.replayed).toBe(true);
    expect(repository.events.at(-1)?.status).toBe('DUPLICATE');
    expect(repository.effects).toBe(1);
  });

  it('quarantines a nonce gap', async () => {
    const result = await useCase.execute(signedCommand(privateKey, { nonce: 2 }));

    expect(result.status).toBe('QUARANTINED');
    expect(result.httpStatus).toBe(202);
    expect(repository.effects).toBe(0);
  });

  it('marks a correctly signed old event stale', async () => {
    const result = await useCase.execute(
      signedCommand(privateKey, { observedAt: '2026-08-12T10:00:00.000Z' }),
    );

    expect(result.status).toBe('STALE');
    expect(errorCode(result)).toBe('ORACLE_EVENT_STALE');
  });

  it('replays one stored result 1000 times without another effect', async () => {
    const command = signedCommand(privateKey);
    await useCase.execute(command);

    for (let index = 0; index < 1000; index += 1) {
      const replay = await useCase.execute(command);
      expect(replay.replayed).toBe(true);
    }

    expect(repository.events).toHaveLength(1);
    expect(repository.effects).toBe(1);
  });
});

function signedCommand(
  privateKey: KeyObject,
  override: Partial<Omit<OracleEventEnvelope, 'signature'>> = {},
): AcceptOracleEventCommand {
  const unsigned = {
    eventId: randomUUID(),
    schemaVersion: '1',
    instrumentId: '048c13bb-7af1-44e4-9219-22b2cb58c25d',
    assetId: 'ezr-1',
    eventType: 'RECEIPT_LOCKED',
    quantity: '1000',
    unit: 'KG',
    observedAt: '2026-08-14T11:00:00.000Z',
    effectiveAt: '2026-08-14T11:00:00.000Z',
    sourceId: 'mock-ezr',
    evidenceHash: 'sha256:0123456789abcdef',
    nonce: 1,
    ...override,
  } satisfies Omit<OracleEventEnvelope, 'signature'>;
  const signatureValue = sign(null, canonicalOraclePayload(unsigned), privateKey).toString(
    'base64url',
  );
  const payload: OracleEventEnvelope = {
    ...unsigned,
    signature: { algorithm: 'Ed25519', keyId: 'mock-key-1', value: signatureValue },
  };
  return {
    payload,
    idempotencyKey: `oracle-${randomUUID()}`,
    correlationId: randomUUID(),
    detachedSignature: signatureValue,
  };
}

function trustedKey(publicKeyPem: string): TrustedSourceKey {
  return {
    sourceId: 'mock-ezr',
    keyId: 'mock-key-1',
    algorithm: 'Ed25519',
    publicKeyPem,
    revokedAt: null,
  };
}

function errorCode(result: AcceptOracleEventResult): string | undefined {
  return 'code' in result.body ? result.body.code : undefined;
}

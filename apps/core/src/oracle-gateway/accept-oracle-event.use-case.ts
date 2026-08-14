import { createHash } from 'node:crypto';

import { canonicalizeJson, canonicalOraclePayload } from './canonical-json.js';
import type { OracleSignatureVerifier } from './ed25519-verifier.js';
import type {
  OracleEventRepository,
  OracleEventTransaction,
  StoredOracleEvent,
} from './oracle-event.repository.js';
import type {
  AcceptOracleEventCommand,
  AcceptOracleEventResult,
  Clock,
  OracleEnvelopeValidator,
  OracleErrorCode,
  OracleErrorDetail,
  OracleErrorResponse,
  OracleEventEnvelope,
  OracleEventReceipt,
  OracleProcessingStatus,
} from './oracle-event.types.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface AcceptOracleEventOptions {
  readonly freshnessWindowMs: number;
}

export class AcceptOracleEventUseCase {
  public constructor(
    private readonly repository: OracleEventRepository,
    private readonly validator: OracleEnvelopeValidator,
    private readonly signatureVerifier: OracleSignatureVerifier,
    private readonly clock: Clock,
    private readonly options: AcceptOracleEventOptions,
  ) {
    if (!Number.isSafeInteger(options.freshnessWindowMs) || options.freshnessWindowMs <= 0) {
      throw new TypeError('freshnessWindowMs must be a positive safe integer');
    }
  }

  public async execute(command: AcceptOracleEventCommand): Promise<AcceptOracleEventResult> {
    const commandIssue = validateCommand(command);
    if (commandIssue !== null) {
      return errorResult('REJECTED', 400, 'VALIDATION_ERROR', commandIssue, command.correlationId, [
        { reason: commandIssue },
      ]);
    }

    const canonicalRequest = canonicalizeJson(command.payload);
    const requestHash = createHash('sha256').update(canonicalRequest, 'utf8').digest();
    const partialIdentity = extractValidIdentity(command.payload);

    return this.repository.withTransaction(async (transaction) => {
      await transaction.lockIdempotencyKey(command.idempotencyKey);
      const idempotent = await transaction.findByIdempotencyKey(command.idempotencyKey);
      if (idempotent !== null) {
        return idempotent.requestHash.equals(requestHash)
          ? replayStoredResult(idempotent)
          : conflictResult(command.correlationId, 'Idempotency-Key was reused with another body');
      }

      if (partialIdentity.sourceId !== null) {
        await transaction.lockSource(partialIdentity.sourceId);
      }

      if (partialIdentity.sourceId !== null && partialIdentity.eventId !== null) {
        const priorEvent = await transaction.findBySourceEvent(
          partialIdentity.sourceId,
          partialIdentity.eventId,
        );
        if (priorEvent !== null) {
          return priorEvent.requestHash.equals(requestHash)
            ? replayStoredResult(priorEvent)
            : conflictResult(
                command.correlationId,
                'sourceId/eventId was reused with another body',
              );
        }
      }

      const stored = await transaction.insertReceived({
        sourceId: partialIdentity.sourceId,
        eventId: partialIdentity.eventId,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
        requestHash,
        rawPayload: command.payload,
      });

      const validation = this.validator.validate(command.payload);
      if (!validation.valid) {
        const result = errorResult(
          'REJECTED',
          400,
          'VALIDATION_ERROR',
          'Oracle event does not match OracleEventEnvelope',
          command.correlationId,
          validation.issues,
        );
        await transaction.complete({
          id: stored.id,
          from: 'RECEIVED',
          to: 'REJECTED',
          result,
          failureCode: result.body.code,
          failureDetails: validation.issues,
        });
        return result;
      }

      const envelope = validation.value;
      if (!Number.isSafeInteger(envelope.nonce)) {
        const result = errorResult(
          'REJECTED',
          400,
          'VALIDATION_ERROR',
          'nonce must be a safe integer',
          command.correlationId,
          [{ field: '/nonce', reason: 'must be a safe integer' }],
        );
        await transaction.complete({
          id: stored.id,
          from: 'RECEIVED',
          to: 'REJECTED',
          result,
          failureCode: result.body.code,
          failureDetails: result.body.details,
        });
        return result;
      }

      await transaction.hydrateValidated(stored.id, envelope);
      await transaction.transition(stored.id, 'RECEIVED', 'SCHEMA_VALIDATED');

      const signatureFailure = await this.validateSignature(
        transaction,
        envelope,
        command.detachedSignature,
      );
      if (signatureFailure !== null) {
        const result = errorResult(
          'REJECTED',
          422,
          signatureFailure.code,
          signatureFailure.message,
          command.correlationId,
          [{ reason: signatureFailure.message }],
        );
        await transaction.complete({
          id: stored.id,
          from: 'SCHEMA_VALIDATED',
          to: 'REJECTED',
          result,
          failureCode: signatureFailure.code,
          failureDetails: result.body.details,
        });
        return result;
      }

      await transaction.transition(stored.id, 'SCHEMA_VALIDATED', 'SIGNATURE_VALIDATED');
      const nonce = BigInt(envelope.nonce);
      const lastAppliedNonce = await transaction.lastAppliedNonce(envelope.sourceId);

      if (nonce <= lastAppliedNonce) {
        const original = await transaction.findAppliedByNonce(envelope.sourceId, nonce);
        const result =
          original === null
            ? receiptResult(envelope.eventId, stored.createdAt, 'DUPLICATE')
            : replayStoredResult(original, 'DUPLICATE');
        await transaction.complete({
          id: stored.id,
          from: 'SIGNATURE_VALIDATED',
          to: 'DUPLICATE',
          result,
          failureCode: 'ORACLE_NONCE_INVALID',
          failureDetails: [
            {
              nonce: envelope.nonce,
              lastAppliedNonce: lastAppliedNonce.toString(),
            },
          ],
        });
        return result;
      }

      if (nonce > lastAppliedNonce + 1n) {
        const result = receiptResult(envelope.eventId, stored.createdAt, 'QUARANTINED');
        await transaction.complete({
          id: stored.id,
          from: 'SIGNATURE_VALIDATED',
          to: 'QUARANTINED',
          result,
          failureCode: 'ORACLE_NONCE_GAP',
          failureDetails: [
            {
              nonce: envelope.nonce,
              expectedNonce: (lastAppliedNonce + 1n).toString(),
            },
          ],
        });
        return result;
      }

      const observedAtMs = Date.parse(envelope.observedAt);
      if (observedAtMs < this.clock.now().getTime() - this.options.freshnessWindowMs) {
        const result = errorResult(
          'STALE',
          422,
          'ORACLE_EVENT_STALE',
          'Oracle event is outside the freshness window',
          command.correlationId,
          [{ field: '/observedAt', reason: 'is older than the configured freshness window' }],
        );
        await transaction.complete({
          id: stored.id,
          from: 'SIGNATURE_VALIDATED',
          to: 'STALE',
          result,
          failureCode: result.body.code,
          failureDetails: result.body.details,
        });
        return result;
      }

      await transaction.transition(stored.id, 'SIGNATURE_VALIDATED', 'POLICY_VALIDATED');
      const result = receiptResult(envelope.eventId, stored.createdAt, 'APPLIED');
      await transaction.apply({ stored, envelope, correlationId: command.correlationId, result });
      return result;
    });
  }

  private async validateSignature(
    transaction: OracleEventTransaction,
    envelope: OracleEventEnvelope,
    detachedSignature: string,
  ): Promise<{ readonly code: OracleErrorCode; readonly message: string } | null> {
    if (
      envelope.signature.algorithm !== 'Ed25519' ||
      detachedSignature !== envelope.signature.value
    ) {
      return {
        code: 'ORACLE_SIGNATURE_INVALID',
        message: 'Oracle signature metadata or detached signature is invalid',
      };
    }

    const sourceKey = await transaction.findTrustedKey(envelope.sourceId, envelope.signature.keyId);
    if (sourceKey === null) {
      return { code: 'ORACLE_SOURCE_UNKNOWN', message: 'Oracle source key is not trusted' };
    }
    if (sourceKey.revokedAt !== null) {
      return { code: 'ORACLE_SOURCE_KEY_REVOKED', message: 'Oracle source key is revoked' };
    }
    if (
      sourceKey.algorithm !== 'Ed25519' ||
      !this.signatureVerifier.verify({
        canonicalPayload: canonicalOraclePayload(envelope),
        signature: envelope.signature.value,
        publicKeyPem: sourceKey.publicKeyPem,
      })
    ) {
      return { code: 'ORACLE_SIGNATURE_INVALID', message: 'Oracle signature is invalid' };
    }

    return null;
  }
}

function validateCommand(command: AcceptOracleEventCommand): string | null {
  if (!IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)) {
    return 'Idempotency-Key is missing or invalid';
  }
  if (!UUID_PATTERN.test(command.correlationId)) {
    return 'X-Correlation-Id is missing or invalid';
  }
  if (command.detachedSignature.length === 0) {
    return 'X-Oracle-Signature is required';
  }
  return null;
}

function extractValidIdentity(payload: unknown): {
  readonly sourceId: string | null;
  readonly eventId: string | null;
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { sourceId: null, eventId: null };
  }
  const record = payload as Readonly<Record<string, unknown>>;
  const sourceId =
    typeof record['sourceId'] === 'string' && SOURCE_ID_PATTERN.test(record['sourceId'])
      ? record['sourceId']
      : null;
  const eventId =
    typeof record['eventId'] === 'string' && UUID_PATTERN.test(record['eventId'])
      ? record['eventId']
      : null;
  return { sourceId, eventId };
}

function receiptResult(
  eventId: string,
  acceptedAt: string,
  status: Extract<OracleProcessingStatus, 'APPLIED' | 'DUPLICATE' | 'QUARANTINED'>,
): AcceptOracleEventResult {
  return {
    status,
    httpStatus: 202,
    replayed: false,
    body: { eventId, acceptedAt, status, replayed: false },
  };
}

function errorResult(
  status: Extract<OracleProcessingStatus, 'REJECTED' | 'STALE'>,
  httpStatus: 400 | 409 | 422,
  code: OracleErrorCode,
  message: string,
  correlationId: string,
  details: readonly OracleErrorDetail[],
): AcceptOracleEventResult & { readonly body: OracleErrorResponse } {
  return {
    status,
    httpStatus,
    replayed: false,
    body: { code, message, correlationId, details },
  };
}

function conflictResult(correlationId: string, message: string): AcceptOracleEventResult {
  return errorResult('REJECTED', 409, 'IDEMPOTENCY_KEY_REUSED', message, correlationId, [
    { reason: message },
  ]);
}

function replayStoredResult(
  stored: StoredOracleEvent,
  statusOverride?: OracleProcessingStatus,
): AcceptOracleEventResult {
  if (stored.httpStatus === null || stored.responseBody === null) {
    throw new Error(`Oracle event ${stored.id} has no stored HTTP result`);
  }

  const body = isReceipt(stored.responseBody)
    ? { ...stored.responseBody, replayed: true }
    : stored.responseBody;
  return {
    status: statusOverride ?? stored.status,
    httpStatus: stored.httpStatus,
    body,
    replayed: true,
  };
}

function isReceipt(body: OracleEventReceipt | OracleErrorResponse): body is OracleEventReceipt {
  return 'eventId' in body;
}

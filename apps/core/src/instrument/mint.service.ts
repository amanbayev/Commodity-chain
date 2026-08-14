import { createHash, randomUUID } from 'node:crypto';

import { PostgresLedger } from '@commodity-chain/ledger';
import type { LedgerAccountId, PostingId } from '@commodity-chain/ledger';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { canonicalizeJson } from '../oracle-gateway/canonical-json.js';
import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import type {
  MintCommand,
  MintErrorBody,
  MintErrorCode,
  MintExecutionResult,
  MintSuccessBody,
} from './mint.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const UNIT_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;

interface StoredCommandRow extends QueryResultRow {
  request_hash: Buffer;
  http_status: number;
  response_body: MintSuccessBody | MintErrorBody;
}

interface InstrumentRow extends QueryResultRow {
  id: string;
  status: string;
  unit: string;
  unit_per_token: string;
  supply_cap: string;
  circulating_supply: string;
}

interface TokenAccountsRow extends QueryResultRow {
  distribution_account_id: string;
  issuance_account_id: string;
  distribution_valid: boolean;
  issuance_valid: boolean;
}

interface ProofPositionRow extends QueryResultRow {
  reserved: string;
  unit: string;
  evidence_hash_matches: boolean;
}

export class MintService {
  private readonly ledger: PostgresLedger;

  public constructor(
    private readonly pool: Pool,
    private readonly collateral: PostgresCollateralLedger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ledger = new PostgresLedger(pool);
  }

  public async execute(command: MintCommand): Promise<MintExecutionResult> {
    const commandError = validateCommand(command);
    if (commandError !== null) {
      return errorResult(400, 'VALIDATION_ERROR', commandError, command.correlationId);
    }

    const requestHash = hashCommand(command);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `mint:${command.idempotencyKey}`,
      ]);

      const stored = await this.readStoredCommand(client, command.idempotencyKey);
      if (stored !== null) {
        const result = stored.request_hash.equals(requestHash)
          ? replayStored(stored)
          : errorResult(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was reused with another mint command',
              command.correlationId,
            );
        await client.query('COMMIT');
        return result;
      }

      const instrument = await this.lockInstrument(client, command.instrumentId);
      if (instrument === null) {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            404,
            'RESOURCE_NOT_FOUND',
            `Instrument ${command.instrumentId} was not found`,
            command.correlationId,
          ),
        );
      }
      if (instrument.status !== 'COLLATERALIZED' && instrument.status !== 'ACTIVE') {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            409,
            'INVALID_STATUS',
            `Instrument status ${instrument.status} does not allow mint`,
            command.correlationId,
          ),
        );
      }
      if (instrument.unit !== command.unit) {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            400,
            'VALIDATION_ERROR',
            'Mint unit must match the instrument unit',
            command.correlationId,
          ),
        );
      }

      const proofValid = await this.validateProof(client, command);
      if (!proofValid) {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            422,
            'COLLATERAL_PROOF_INVALID',
            'Collateral proof does not match persisted verified collateral',
            command.correlationId,
          ),
        );
      }

      const currentSupply = BigInt(instrument.circulating_supply);
      const nextSupply = currentSupply + command.quantity;
      if (nextSupply > BigInt(instrument.supply_cap)) {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            422,
            'SUPPLY_CAP_EXCEEDED',
            'Mint would exceed the instrument supply cap',
            command.correlationId,
          ),
        );
      }

      const verifiedAvailable = await this.collateral.verifiedAvailableWithin(
        client,
        command.instrumentId,
      );
      const requiredCollateral = nextSupply * BigInt(instrument.unit_per_token);
      if (requiredCollateral > verifiedAvailable) {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            422,
            'SUPPLY_EXCEEDS_COLLATERAL',
            'Mint would exceed verified collateral',
            command.correlationId,
          ),
        );
      }

      const accounts = await this.readTokenAccounts(client, command.instrumentId);
      if (accounts === null || !accounts.distribution_valid || !accounts.issuance_valid) {
        return this.completeFailure(
          client,
          command,
          requestHash,
          errorResult(
            422,
            'MINT_ACCOUNT_NOT_CONFIGURED',
            'Instrument distribution and issuance accounts are not configured',
            command.correlationId,
          ),
        );
      }

      const ledgerPosting = await this.ledger.withinTransaction(client).post({
        idempotencyKey: ledgerIdempotencyKey(command.idempotencyKey),
        correlationId: command.correlationId,
        legs: [
          {
            accountId: accounts.issuance_account_id as LedgerAccountId,
            direction: 'DEBIT',
            amount: command.quantity,
          },
          {
            accountId: accounts.distribution_account_id as LedgerAccountId,
            direction: 'CREDIT',
            amount: command.quantity,
          },
        ],
        metadata: {
          operation: 'MINT',
          instrumentId: command.instrumentId,
          quantity: command.quantity.toString(),
        },
      });
      const mintedAt = this.now().toISOString();
      await client.query(
        `
          UPDATE instrument
          SET circulating_supply = $2, updated_at = $3
          WHERE id = $1
        `,
        [command.instrumentId, nextSupply.toString(), mintedAt],
      );

      const body: MintSuccessBody = {
        instrumentId: command.instrumentId,
        mintedQuantity: command.quantity.toString(),
        unit: command.unit,
        totalSupply: nextSupply.toString(),
        status: instrument.status,
        mintedAt,
      };
      const result: MintExecutionResult = { httpStatus: 201, body, replayed: false };
      const domainEventId = randomUUID();
      const auditResult = await client.query<{ id: string } & QueryResultRow>(
        `
          INSERT INTO event_log (
            occurred_at,
            actor,
            event_type,
            aggregate_type,
            aggregate_id,
            correlation_id,
            payload
          )
          VALUES ($1, 'system:mint', 'TOKENS_MINTED', 'INSTRUMENT', $2, $3, $4::jsonb)
          RETURNING id::text
        `,
        [
          mintedAt,
          command.instrumentId,
          command.correlationId,
          JSON.stringify({
            eventId: domainEventId,
            instrumentId: command.instrumentId,
            mintedQuantity: command.quantity.toString(),
            totalSupply: nextSupply.toString(),
            unit: command.unit,
            ledgerPostingId: ledgerPosting.id,
          }),
        ],
      );
      const eventNonce = auditResult.rows[0]!.id;
      await client.query(
        `INSERT INTO outbox (topic, payload) VALUES ('domain.instrument.minted.v1', $1::jsonb)`,
        [
          JSON.stringify({
            eventId: domainEventId,
            nonce: eventNonce,
            eventType: 'TOKENS_MINTED',
            schemaVersion: '1',
            occurredAt: mintedAt,
            payload: body,
          }),
        ],
      );
      await this.storeCommand(client, command, requestHash, result, ledgerPosting.id);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeFailure(
    client: PoolClient,
    command: MintCommand,
    requestHash: Buffer,
    result: MintExecutionResult,
  ): Promise<MintExecutionResult> {
    await this.storeCommand(client, command, requestHash, result, null);
    await client.query('COMMIT');
    return result;
  }

  private async storeCommand(
    client: PoolClient,
    command: MintCommand,
    requestHash: Buffer,
    result: MintExecutionResult,
    ledgerPostingId: PostingId | null,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO mint_commands (
          idempotency_key,
          request_hash,
          instrument_id,
          http_status,
          response_body,
          ledger_posting_id
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [
        command.idempotencyKey,
        requestHash,
        command.instrumentId,
        result.httpStatus,
        JSON.stringify(result.body),
        ledgerPostingId,
      ],
    );
  }

  private async readStoredCommand(
    client: PoolClient,
    idempotencyKey: string,
  ): Promise<StoredCommandRow | null> {
    const result = await client.query<StoredCommandRow>(
      `
        SELECT request_hash, http_status, response_body
        FROM mint_commands
        WHERE idempotency_key = $1
      `,
      [idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  private async lockInstrument(
    client: PoolClient,
    instrumentId: string,
  ): Promise<InstrumentRow | null> {
    const result = await client.query<InstrumentRow>(
      `
        SELECT
          id::text,
          status::text,
          unit,
          unit_per_token::text,
          supply_cap::text,
          circulating_supply::text
        FROM instrument
        WHERE id = $1
        FOR UPDATE
      `,
      [instrumentId],
    );
    return result.rows[0] ?? null;
  }

  private async readTokenAccounts(
    client: PoolClient,
    instrumentId: string,
  ): Promise<TokenAccountsRow | null> {
    const result = await client.query<TokenAccountsRow>(
      `
        SELECT
          mapping.distribution_account_id::text,
          mapping.issuance_account_id::text,
          (
            distribution.account_type = 'TOKEN'
            AND distribution.instrument_id = mapping.instrument_id
            AND distribution.purpose = 'AVAILABLE'
            AND distribution.normal_side = 'CREDIT'
          ) AS distribution_valid,
          (
            issuance.account_type = 'TOKEN'
            AND issuance.instrument_id = mapping.instrument_id
            AND issuance.purpose = 'RESIDUAL'
            AND issuance.normal_side = 'DEBIT'
          ) AS issuance_valid
        FROM instrument_token_accounts AS mapping
        JOIN ledger_accounts AS distribution ON distribution.id = mapping.distribution_account_id
        JOIN ledger_accounts AS issuance ON issuance.id = mapping.issuance_account_id
        WHERE mapping.instrument_id = $1
      `,
      [instrumentId],
    );
    return result.rows[0] ?? null;
  }

  private async validateProof(client: PoolClient, command: MintCommand): Promise<boolean> {
    const proof = command.collateralProof;
    if (
      proof.instrumentId !== command.instrumentId ||
      proof.unit !== command.unit ||
      !POSITIVE_INTEGER_PATTERN.test(proof.reserved) ||
      proof.evidenceHash.length < 16 ||
      proof.verifierProofs.length === 0
    ) {
      return false;
    }
    const result = await client.query<ProofPositionRow>(
      `
        SELECT
          reserved::text,
          unit,
          EXISTS (
            SELECT 1
            FROM jsonb_array_elements(verifier_proofs) AS proof
            WHERE proof ->> 'evidenceHash' = $3
          ) AS evidence_hash_matches
        FROM collateral_position
        WHERE asset_id = $1 AND instrument_id = $2
      `,
      [proof.assetId, command.instrumentId, proof.evidenceHash],
    );
    const position = result.rows[0];
    return (
      position !== undefined &&
      position.unit === proof.unit &&
      position.evidence_hash_matches &&
      BigInt(position.reserved) >= BigInt(proof.reserved)
    );
  }
}

function validateCommand(command: MintCommand): string | null {
  if (!UUID_PATTERN.test(command.instrumentId)) {
    return 'instrumentId must be a UUID';
  }
  if (!UUID_PATTERN.test(command.correlationId)) {
    return 'X-Correlation-Id must be a UUID';
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(command.idempotencyKey)) {
    return 'Idempotency-Key is missing or invalid';
  }
  if (
    typeof command.quantity !== 'bigint' ||
    command.quantity <= 0n ||
    command.quantity > MAX_NUMERIC_38
  ) {
    return 'quantity must be a positive bigint within NUMERIC(38,0)';
  }
  if (!UNIT_PATTERN.test(command.unit)) {
    return 'unit is invalid';
  }
  return null;
}

function hashCommand(command: MintCommand): Buffer {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        instrumentId: command.instrumentId,
        quantity: command.quantity.toString(),
        unit: command.unit,
        collateralProof: command.collateralProof,
      }),
      'utf8',
    )
    .digest();
}

function ledgerIdempotencyKey(idempotencyKey: string): string {
  return `mint:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

function errorResult(
  httpStatus: 400 | 404 | 409 | 422,
  code: MintErrorCode,
  message: string,
  correlationId: string,
): MintExecutionResult {
  return {
    httpStatus,
    replayed: false,
    body: { code, message, correlationId, details: [{ reason: message }] },
  };
}

function replayStored(stored: StoredCommandRow): MintExecutionResult {
  if (
    stored.http_status !== 201 &&
    stored.http_status !== 400 &&
    stored.http_status !== 404 &&
    stored.http_status !== 409 &&
    stored.http_status !== 422
  ) {
    throw new Error(`Unsupported stored mint HTTP status ${stored.http_status}`);
  }
  return { httpStatus: stored.http_status, body: stored.response_body, replayed: true };
}

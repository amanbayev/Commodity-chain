import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { InstrumentListingError } from './instrument-listing.errors.js';
import type {
  CollateralReservedDomainEvent,
  CollateralSummaryResult,
  CreateInstrumentDraftCommand,
  InstrumentDraftResult,
  InstrumentMarketPage,
  InstrumentSubmissionResult,
  IssuerInstrumentPage,
  IssuerInstrumentResult,
  InternalTransitionCommand,
  PublicPassportResult,
  ReviewCommand,
  ReviewResult,
  RevisePassportCommand,
  SubmitInstrumentCommand,
  UpdateInstrumentDraftCommand,
} from './instrument-listing.types.js';
import {
  assertCompletePassport,
  hashPassport,
  IncompletePassportError,
  passportFromJson,
  passportToJson,
  parsePassportDraft,
} from './instrument-passport.js';
import type { InstrumentView, LegalNature, PassportDraft } from './instrument-passport.js';
import {
  InvalidInstrumentTransitionError,
  isInstrumentStatus,
  transitionInstrument,
} from './instrument-state-machine.js';
import type { InstrumentStatus } from './instrument-state-machine.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const MAX_NUMERIC_38 = 10n ** 38n - 1n;

interface InstrumentRow extends QueryResultRow {
  id: string;
  type: string;
  legal_nature: LegalNature;
  status: string;
  currency: string;
  unit: string;
  unit_per_token: string;
  supply_cap: string;
  circulating_supply: string;
  version: string;
  passport_hash: string | null;
  suspended_from_status: string | null;
  extensions: Readonly<Record<string, unknown>>;
  created_at: Date | string;
  updated_at: Date | string;
  issuer_id: string;
}

interface PassportRow extends QueryResultRow {
  version: string;
  passport: Readonly<Record<string, unknown>>;
  review_state: 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'REJECTED' | 'APPROVED';
  passport_hash: string | null;
  submitted_at: Date | string | null;
  published_at: Date | string | null;
}

interface MarketInstrumentRow extends InstrumentRow {
  passport: Readonly<Record<string, unknown>>;
  available_supply: string;
  trading_volume_24h: string;
  last_trade_price: string | null;
  price_change_bps: string | null;
}

interface IssuerInstrumentRow extends InstrumentRow {
  passport: Readonly<Record<string, unknown>>;
  verified_available: string;
}

interface CollateralPositionRow extends QueryResultRow {
  asset_id: string;
  reserved: string;
  available: string;
  unit: string;
  verifier_proofs: readonly unknown[];
  updated_at: Date | string;
}

interface DomainEventIdentity {
  readonly eventId: string;
  readonly nonce: string;
  readonly occurredAt: string;
}

export class InstrumentListingService {
  public constructor(
    private readonly pool: Pool,
    private readonly collateral: PostgresCollateralLedger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async createDraft(command: CreateInstrumentDraftCommand): Promise<InstrumentDraftResult> {
    validateCreateDraft(command);
    const passportJson = passportToJson(command.passport);
    const instrumentId = randomUUID();
    const occurredAt = this.now().toISOString();

    return this.withTransaction(async (client) => {
      const result = await client.query<InstrumentRow>(
        `
          INSERT INTO instrument (
            id, type, legal_nature, status, currency, unit, unit_per_token,
            supply_cap, version, extensions, issuer_id, created_at, updated_at
          )
          VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, 1, $8::jsonb, $9, $10, $10)
          RETURNING ${INSTRUMENT_COLUMNS}
        `,
        [
          instrumentId,
          command.type,
          command.legalNature,
          command.currency,
          command.unit,
          command.unitPerToken.toString(),
          command.supplyCap.toString(),
          JSON.stringify(command.extensions ?? {}),
          command.actorId,
          occurredAt,
        ],
      );
      const instrument = requireRow(result.rows[0], 'Created instrument was not returned');
      await client.query(
        `
          INSERT INTO instrument_passport_versions (
            instrument_id, version, passport, review_state, created_by, created_at, updated_at
          )
          VALUES ($1, 1, $2::jsonb, 'DRAFT', $3, $4, $4)
        `,
        [instrumentId, JSON.stringify(passportJson), command.actorId, occurredAt],
      );
      await this.appendDomainEvent(client, {
        eventType: 'INSTRUMENT_DRAFT_CREATED',
        topic: 'domain.instrument.draft-created.v1',
        instrumentId,
        actor: command.actorId,
        reason: 'Instrument passport draft created',
        correlationId: command.correlationId,
        occurredAt,
        payload: { version: '1' },
      });
      return { instrument: mapInstrument(instrument), passport: passportJson, version: 1 };
    });
  }

  public async updateDraft(command: UpdateInstrumentDraftCommand): Promise<InstrumentDraftResult> {
    validateCreateDraft(command);
    assertUuid(command.instrumentId, 'instrumentId');
    assertPositiveVersion(command.version);
    const passportJson = passportToJson(command.passport);
    return this.withTransaction(async (client) => {
      const instrument = await this.lockInstrument(client, command.instrumentId);
      assertIssuer(instrument, command.actorId);
      if (instrument.status !== 'DRAFT') throw invalidTransition(instrument.status, 'DRAFT');
      if (BigInt(instrument.version) !== command.version) {
        throw new InstrumentListingError('CONFLICT', 'Draft version is stale', 409);
      }
      const passport = await this.lockCurrentPassport(client, instrument);
      if (passport.review_state !== 'DRAFT') {
        throw new InstrumentListingError('CONFLICT', 'Passport is not editable', 409);
      }
      const occurredAt = this.now().toISOString();
      const updated = await client.query<InstrumentRow>(
        `UPDATE instrument
         SET type = $2, legal_nature = $3, currency = $4, unit = $5,
             unit_per_token = $6, supply_cap = $7, extensions = $8::jsonb, updated_at = $9
         WHERE id = $1
         RETURNING ${INSTRUMENT_COLUMNS}`,
        [
          instrument.id,
          command.type,
          command.legalNature,
          command.currency,
          command.unit,
          command.unitPerToken.toString(),
          command.supplyCap.toString(),
          JSON.stringify(command.extensions ?? {}),
          occurredAt,
        ],
      );
      await client.query(
        `UPDATE instrument_passport_versions
         SET passport = $3::jsonb, updated_at = $4
         WHERE instrument_id = $1 AND version = $2`,
        [instrument.id, instrument.version, JSON.stringify(passportJson), occurredAt],
      );
      await this.appendDomainEvent(client, {
        eventType: 'INSTRUMENT_DRAFT_UPDATED',
        topic: 'domain.instrument.draft-updated.v1',
        instrumentId: instrument.id,
        actor: command.actorId,
        reason: 'Instrument passport draft saved',
        correlationId: command.correlationId,
        occurredAt,
        payload: { version: instrument.version },
      });
      return {
        instrument: mapInstrument(
          requireRow(updated.rows[0], 'Updated instrument was not returned'),
        ),
        passport: passportJson,
        version: safeVersion(instrument.version),
      };
    });
  }

  public async submit(command: SubmitInstrumentCommand): Promise<InstrumentSubmissionResult> {
    validateCommonCommand(command.instrumentId, command.actorId, command.correlationId);
    assertPositiveVersion(command.version);
    if (command.submissionNote !== undefined && command.submissionNote.length > 2000) {
      throw validationError('submissionNote', 'submissionNote must not exceed 2000 characters');
    }

    return this.withTransaction(async (client) => {
      const instrument = await this.lockInstrument(client, command.instrumentId);
      assertIssuer(instrument, command.actorId);
      if (BigInt(instrument.version) !== command.version) {
        throw new InstrumentListingError(
          'CONFLICT',
          `Passport version ${command.version} is stale; current version is ${instrument.version}`,
          409,
        );
      }
      if (instrument.status !== 'DRAFT' && instrument.status !== 'UNDER_REVIEW') {
        throw invalidTransition(instrument.status, 'UNDER_REVIEW');
      }
      const passportRow = await this.lockCurrentPassport(client, instrument);
      if (passportRow.review_state !== 'DRAFT') {
        throw new InstrumentListingError(
          'CONFLICT',
          `Passport version ${instrument.version} is not a draft`,
          409,
        );
      }

      let passport;
      try {
        passport = assertCompletePassport(passportFromJson(passportRow.passport));
      } catch (error: unknown) {
        if (error instanceof IncompletePassportError) {
          throw new InstrumentListingError(
            'PASSPORT_INCOMPLETE',
            error.message,
            422,
            error.missingFields.map((field) => ({ field, reason: 'Required for listing submit' })),
          );
        }
        throw error;
      }
      const passportHash = hashPassport(
        {
          id: instrument.id,
          type: instrument.type,
          legalNature: instrument.legal_nature,
          currency: instrument.currency,
          unit: instrument.unit,
          unitPerToken: BigInt(instrument.unit_per_token),
          supplyCap: BigInt(instrument.supply_cap),
          version: BigInt(instrument.version),
        },
        passport,
      );
      const submittedAt = this.now().toISOString();
      await client.query(
        `
          UPDATE instrument_passport_versions
          SET review_state = 'SUBMITTED', passport_hash = $3, submission_note = $4,
              submitted_at = $5, updated_at = $5
          WHERE instrument_id = $1 AND version = $2
        `,
        [
          instrument.id,
          instrument.version,
          passportHash,
          command.submissionNote ?? null,
          submittedAt,
        ],
      );
      await client.query(
        'UPDATE instrument SET passport_hash = $2, updated_at = $3 WHERE id = $1',
        [instrument.id, passportHash, submittedAt],
      );

      if (instrument.status === 'DRAFT') {
        await this.transitionWithin(client, instrument, 'UNDER_REVIEW', {
          actor: command.actorId,
          reason: command.submissionNote ?? 'Passport submitted for listing review',
          correlationId: command.correlationId,
          passportVersion: BigInt(instrument.version),
          occurredAt: submittedAt,
        });
      }
      await this.appendDomainEvent(client, {
        eventType: 'INSTRUMENT_PASSPORT_SUBMITTED',
        topic: 'domain.instrument.passport-submitted.v1',
        instrumentId: instrument.id,
        actor: command.actorId,
        reason: command.submissionNote ?? 'Passport submitted for listing review',
        correlationId: command.correlationId,
        occurredAt: submittedAt,
        payload: { version: instrument.version, passportHash },
      });

      const updated = await this.readInstrument(client, instrument.id);
      return {
        instrument: mapInstrument(updated),
        passport: passportToJson(passport),
        passportHash,
        version: safeVersion(instrument.version),
        submittedAt,
      };
    });
  }

  public async listIssuerInstruments(
    issuerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<IssuerInstrumentPage> {
    assertNonBlank(issuerId, 'issuerId');
    const pageCursor = decodeMarketCursor(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw validationError('limit', 'limit must be an integer between 1 and 200');
    }
    const result = await this.pool.query<IssuerInstrumentRow>(
      `WITH issuer_instruments AS (
         SELECT ${INSTRUMENT_COLUMNS}
         FROM instrument
         WHERE issuer_id = $1
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC
         LIMIT $4
       )
       SELECT issuer_instruments.*, passport.passport,
              COALESCE(collateral.verified_available, 0)::text AS verified_available
       FROM issuer_instruments
       JOIN instrument_passport_versions AS passport
         ON passport.instrument_id::text = issuer_instruments.id AND passport.version = issuer_instruments.version::bigint
       LEFT JOIN LATERAL (
         SELECT sum(reserved) AS verified_available
         FROM collateral_position WHERE instrument_id::text = issuer_instruments.id
       ) AS collateral ON true
       ORDER BY issuer_instruments.created_at DESC, issuer_instruments.id DESC`,
      [issuerId, pageCursor?.createdAt ?? null, pageCursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        instrument: mapInstrument(row),
        passport: row.passport,
        ...(row.passport_hash === null ? {} : { passportHash: row.passport_hash }),
        version: safeVersion(row.version),
        verifiedAvailable: row.verified_available,
      })),
      page: {
        limit,
        hasMore,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeMarketCursor(toIso(last.created_at), last.id) }
          : {}),
      },
    };
  }

  public async getIssuerInstrument(
    instrumentId: string,
    issuerId: string,
  ): Promise<IssuerInstrumentResult> {
    assertUuid(instrumentId, 'instrumentId');
    assertNonBlank(issuerId, 'issuerId');
    const instrument = await this.readInstrument(this.pool, instrumentId);
    assertIssuer(instrument, issuerId);
    const passport = await this.pool.query<PassportRow>(
      `SELECT version::text, passport, review_state, passport_hash, submitted_at, published_at
       FROM instrument_passport_versions WHERE instrument_id = $1 AND version = $2`,
      [instrument.id, instrument.version],
    );
    const current = requireRow(passport.rows[0], 'Current passport was not found');
    const positions = await this.readCollateralPositions(instrument.id);
    const verified = await this.collateral.verifiedAvailable(instrument.id);
    return {
      instrument: mapInstrument(instrument),
      passport: current.passport,
      ...(current.passport_hash === null ? {} : { passportHash: current.passport_hash }),
      version: safeVersion(current.version),
      collateralPositions: positions,
      verifiedAvailable: verified.toString(),
    };
  }

  public async getCollateralSummary(
    instrumentId: string,
    issuerId: string,
  ): Promise<CollateralSummaryResult> {
    const issue = await this.getIssuerInstrument(instrumentId, issuerId);
    return {
      instrumentId,
      verifiedAvailable: issue.verifiedAvailable,
      positions: issue.collateralPositions,
    };
  }

  public approve(command: ReviewCommand): Promise<ReviewResult> {
    return this.review(command, 'APPROVE');
  }

  public reject(command: ReviewCommand): Promise<ReviewResult> {
    return this.review(command, 'REJECT');
  }

  public returnForRevision(command: ReviewCommand): Promise<ReviewResult> {
    return this.review(command, 'RETURN_FOR_REVISION');
  }

  public async revisePassport(command: RevisePassportCommand): Promise<InstrumentDraftResult> {
    validateCommonCommand(command.instrumentId, command.actorId, command.correlationId);
    assertNonBlank(command.reason, 'reason');
    validatePassportAmounts(command.passport);
    const passportJson = passportToJson(command.passport);

    return this.withTransaction(async (client) => {
      const instrument = await this.lockInstrument(client, command.instrumentId);
      if (instrument.status !== 'UNDER_REVIEW') {
        throw invalidTransition(instrument.status, 'UNDER_REVIEW');
      }
      const current = await this.lockCurrentPassport(client, instrument);
      if (current.review_state !== 'RETURNED') {
        throw new InstrumentListingError(
          'CONFLICT',
          'A new passport version requires RETURN_FOR_REVISION on the current version',
          409,
        );
      }
      const nextVersion = BigInt(instrument.version) + 1n;
      const occurredAt = this.now().toISOString();
      await client.query(
        `
          INSERT INTO instrument_passport_versions (
            instrument_id, version, passport, review_state, created_by, created_at, updated_at
          )
          VALUES ($1, $2, $3::jsonb, 'DRAFT', $4, $5, $5)
        `,
        [
          instrument.id,
          nextVersion.toString(),
          JSON.stringify(passportJson),
          command.actorId,
          occurredAt,
        ],
      );
      await client.query(
        `UPDATE instrument SET version = $2, passport_hash = NULL, updated_at = $3 WHERE id = $1`,
        [instrument.id, nextVersion.toString(), occurredAt],
      );
      await this.appendDomainEvent(client, {
        eventType: 'INSTRUMENT_PASSPORT_REVISED',
        topic: 'domain.instrument.passport-revised.v1',
        instrumentId: instrument.id,
        actor: command.actorId,
        reason: command.reason,
        correlationId: command.correlationId,
        occurredAt,
        payload: { priorVersion: instrument.version, version: nextVersion.toString() },
      });
      const updated = await this.readInstrument(client, instrument.id);
      return {
        instrument: mapInstrument(updated),
        passport: passportJson,
        version: safeVersion(nextVersion.toString()),
      };
    });
  }

  public async transition(command: InternalTransitionCommand): Promise<InstrumentView> {
    validateCommonCommand(command.instrumentId, command.actorId, command.correlationId);
    assertNonBlank(command.reason, 'reason');
    if (
      command.targetStatus === 'UNDER_REVIEW' ||
      command.targetStatus === 'APPROVED' ||
      command.targetStatus === 'COLLATERALIZED'
    ) {
      throw new InstrumentListingError(
        'INVALID_TRANSITION',
        `${command.targetStatus} is controlled by its dedicated listing workflow`,
        409,
      );
    }
    return this.withTransaction(async (client) => {
      const instrument = await this.lockInstrument(client, command.instrumentId);
      await this.transitionWithin(client, instrument, command.targetStatus, {
        actor: command.actorId,
        reason: command.reason,
        correlationId: command.correlationId,
        passportVersion: BigInt(instrument.version),
        occurredAt: this.now().toISOString(),
      });
      return mapInstrument(await this.readInstrument(client, instrument.id));
    });
  }

  public async applyCollateralReserved(event: CollateralReservedDomainEvent): Promise<boolean> {
    assertUuid(event.eventId, 'eventId');
    assertUuid(event.instrumentId, 'instrumentId');
    assertUuid(event.correlationId, 'correlationId');
    if (!/^(0|[1-9][0-9]*)$/u.test(event.nonce)) {
      throw validationError('nonce', 'nonce must be a non-negative integer string');
    }

    return this.withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT 1 FROM instrument_status_transitions WHERE source_event_id = $1',
        [event.eventId],
      );
      if (existing.rowCount !== 0) return false;

      const instrument = await this.lockInstrument(client, event.instrumentId);
      if (instrument.status !== 'APPROVED') return false;
      const verified = await this.collateral.verifiedAvailableWithin(client, instrument.id);
      const required = BigInt(instrument.supply_cap) * BigInt(instrument.unit_per_token);
      if (verified < required) return false;

      await this.transitionWithin(client, instrument, 'COLLATERALIZED', {
        actor: 'system:collateral',
        reason: 'Verified collateral covers supplyCap multiplied by unitPerToken',
        correlationId: event.correlationId,
        passportVersion: BigInt(instrument.version),
        sourceEventId: event.eventId,
        occurredAt: this.now().toISOString(),
      });
      return true;
    });
  }

  public async getPublicPassport(instrumentId: string): Promise<PublicPassportResult> {
    assertUuid(instrumentId, 'instrumentId');
    const instrument = await this.readInstrument(this.pool, instrumentId);
    const passportResult = await this.pool.query<PassportRow>(
      `
        SELECT version::text, passport, review_state, passport_hash, submitted_at, published_at
        FROM instrument_passport_versions
        WHERE instrument_id = $1 AND published_at IS NOT NULL
        ORDER BY version DESC
        LIMIT 1
      `,
      [instrumentId],
    );
    const passport = passportResult.rows[0];
    if (
      passport === undefined ||
      passport.passport_hash === null ||
      passport.published_at === null
    ) {
      throw new InstrumentListingError(
        'PASSPORT_NOT_PUBLIC',
        `Instrument ${instrumentId} does not have a published passport`,
        404,
      );
    }

    const collateral = await this.pool.query<
      QueryResultRow & {
        asset_id: string;
        class: string;
        owner: string;
        asset_quantity: string;
        asset_unit: string;
        location: string;
        encumbrance_status: string;
        reserved: string;
        available: string;
        verifier_proofs: readonly unknown[];
        position_updated_at: Date | string;
      }
    >(
      `
        SELECT
          asset.asset_id,
          asset.class,
          party.external_id AS owner,
          asset.quantity::text AS asset_quantity,
          asset.unit AS asset_unit,
          asset.location,
          asset.encumbrance_status::text,
          position.reserved::text,
          position.available::text,
          position.verifier_proofs,
          position.updated_at AS position_updated_at
        FROM collateral_position AS position
        JOIN asset ON asset.asset_id = position.asset_id
        JOIN party ON party.id = asset.owner_party_id
        WHERE position.instrument_id = $1
        ORDER BY asset.asset_id
      `,
      [instrumentId],
    );

    return {
      instrument: mapInstrument(instrument),
      passport: passport.passport,
      passportHash: passport.passport_hash,
      version: safeVersion(passport.version),
      assets: collateral.rows.map((row) => ({
        assetId: row.asset_id,
        class: row.class,
        owner: row.owner,
        quantity: row.asset_quantity,
        unit: row.asset_unit,
        location: row.location,
        encumbranceStatus: row.encumbrance_status,
      })),
      collateralPositions: collateral.rows.map((row) => ({
        assetId: row.asset_id,
        instrumentId,
        reserved: row.reserved,
        available: row.available,
        unit: row.asset_unit,
        verifierProofs: row.verifier_proofs,
        updatedAt: toIso(row.position_updated_at),
      })),
      publishedAt: toIso(passport.published_at),
    };
  }

  public async listMarketInstruments(
    cursor: string | undefined,
    limit: number,
  ): Promise<InstrumentMarketPage> {
    const pageCursor = decodeMarketCursor(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw validationError('limit', 'limit must be an integer between 1 and 200');
    }
    const observedAt = this.now().toISOString();
    const result = await this.pool.query<MarketInstrumentRow>(
      `
        WITH public_instruments AS (
          SELECT
            instrument.*,
            passport.passport
          FROM instrument
          JOIN LATERAL (
            SELECT version, passport
            FROM instrument_passport_versions
            WHERE instrument_id = instrument.id AND published_at IS NOT NULL
            ORDER BY version DESC
            LIMIT 1
          ) AS passport ON true
          WHERE ($1::timestamptz IS NULL OR (instrument.created_at, instrument.id) < ($1::timestamptz, $2::uuid))
          ORDER BY instrument.created_at DESC, instrument.id DESC
          LIMIT $4
        )
        SELECT
          public_instruments.id::text,
          public_instruments.type,
          public_instruments.legal_nature::text,
          public_instruments.status::text,
          public_instruments.currency,
          public_instruments.unit,
          public_instruments.unit_per_token::text,
          public_instruments.supply_cap::text,
          public_instruments.circulating_supply::text,
          public_instruments.version::text,
          public_instruments.passport_hash,
          public_instruments.suspended_from_status::text,
          public_instruments.extensions,
          public_instruments.created_at,
          public_instruments.updated_at,
          public_instruments.passport,
          COALESCE(sell_orders.available_supply, 0)::text AS available_supply,
          COALESCE(volume.trading_volume_24h, 0)::text AS trading_volume_24h,
          latest.price::text AS last_trade_price,
          CASE
            WHEN latest.price IS NULL OR baseline.price IS NULL OR baseline.price = 0 THEN NULL
            ELSE trunc((latest.price - baseline.price) * 10000 / baseline.price)::text
          END AS price_change_bps
        FROM public_instruments
        LEFT JOIN LATERAL (
          SELECT sum(open_quantity) AS available_supply
          FROM orders
          WHERE instrument_id = public_instruments.id
            AND side = 'SELL'
            AND status IN ('OPEN', 'PARTIALLY_FILLED')
        ) AS sell_orders ON true
        LEFT JOIN LATERAL (
          SELECT sum(price * quantity) AS trading_volume_24h
          FROM trades
          WHERE instrument_id = public_instruments.id
            AND executed_at >= $3::timestamptz - interval '24 hours'
        ) AS volume ON true
        LEFT JOIN LATERAL (
          SELECT price
          FROM trades
          WHERE instrument_id = public_instruments.id
          ORDER BY executed_at DESC, trade_id DESC
          LIMIT 1
        ) AS latest ON true
        LEFT JOIN LATERAL (
          SELECT price
          FROM trades
          WHERE instrument_id = public_instruments.id
            AND executed_at <= $3::timestamptz - interval '24 hours'
          ORDER BY executed_at DESC, trade_id DESC
          LIMIT 1
        ) AS baseline ON true
        ORDER BY public_instruments.created_at DESC, public_instruments.id DESC
      `,
      [pageCursor?.createdAt ?? null, pageCursor?.id ?? null, observedAt, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => {
      const passport = assertCompletePassport(passportFromJson(row.passport));
      const tickerValue = row.extensions['ticker'];
      const ticker =
        typeof tickerValue === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,31}$/u.test(tickerValue)
          ? tickerValue
          : undefined;
      return {
        instrument: mapInstrument(row),
        ...(ticker === undefined ? {} : { ticker }),
        name: `${passport.underlyingAsset.commodity} ${passport.underlyingAsset.grade}`,
        ...(row.last_trade_price === null ? {} : { lastTradePrice: row.last_trade_price }),
        ...(row.price_change_bps === null ? {} : { priceChangeBps: row.price_change_bps }),
        availableSupply: row.available_supply,
        tradingVolume24h: row.trading_volume_24h,
      };
    });
    const lastRow = rows.at(-1);
    return {
      items,
      page: {
        limit,
        hasMore,
        ...(hasMore && lastRow !== undefined
          ? { nextCursor: encodeMarketCursor(toIso(lastRow.created_at), lastRow.id) }
          : {}),
      },
    };
  }

  private async review(
    command: ReviewCommand,
    decision: 'APPROVE' | 'REJECT' | 'RETURN_FOR_REVISION',
  ): Promise<ReviewResult> {
    validateCommonCommand(command.instrumentId, command.operatorId, command.correlationId);
    assertNonBlank(command.comment, 'comment');
    if (command.comment.length > 4000) {
      throw validationError('comment', 'comment must not exceed 4000 characters');
    }

    return this.withTransaction(async (client) => {
      const instrument = await this.lockInstrument(client, command.instrumentId);
      if (instrument.status !== 'UNDER_REVIEW') {
        throw invalidTransition(instrument.status, 'APPROVED');
      }
      const passport = await this.lockCurrentPassport(client, instrument);
      if (passport.review_state !== 'SUBMITTED') {
        throw new InstrumentListingError(
          'CONFLICT',
          `Passport version ${passport.version} is not awaiting a review decision`,
          409,
        );
      }

      if (decision === 'APPROVE') {
        const prior = await client.query(
          `
            SELECT 1 FROM instrument_review_decisions
            WHERE instrument_id = $1 AND passport_version = $2
              AND operator_id = $3 AND decision = 'APPROVE'
          `,
          [instrument.id, passport.version, command.operatorId],
        );
        if (prior.rowCount !== 0) {
          throw new InstrumentListingError(
            'FOUR_EYES_REQUIRED',
            'The second listing approval must come from a different operator',
            409,
          );
        }
      }

      const decidedAt = this.now().toISOString();
      await client.query(
        `
          INSERT INTO instrument_review_decisions (
            instrument_id, passport_version, operator_id, decision,
            internal_comment, correlation_id, decided_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          instrument.id,
          passport.version,
          command.operatorId,
          decision,
          command.comment,
          command.correlationId,
          decidedAt,
        ],
      );
      const countResult = await client.query<{ count: string } & QueryResultRow>(
        `
          SELECT count(DISTINCT operator_id)::text AS count
          FROM instrument_review_decisions
          WHERE instrument_id = $1 AND passport_version = $2 AND decision = 'APPROVE'
        `,
        [instrument.id, passport.version],
      );
      const approvalCount = Number(countResult.rows[0]?.count ?? '0');
      await this.appendDomainEvent(client, {
        eventType: `LISTING_${decision}`,
        topic: `domain.instrument.listing-${decision.toLowerCase().replaceAll('_', '-')}.v1`,
        instrumentId: instrument.id,
        actor: command.operatorId,
        reason: command.comment,
        correlationId: command.correlationId,
        occurredAt: decidedAt,
        payload: { version: passport.version, decision, distinctApprovalCount: approvalCount },
      });

      if (decision === 'APPROVE' && approvalCount >= 2) {
        await client.query(
          `
            UPDATE instrument_passport_versions
            SET review_state = 'APPROVED', published_at = $3, updated_at = $3
            WHERE instrument_id = $1 AND version = $2
          `,
          [instrument.id, passport.version, decidedAt],
        );
        await this.transitionWithin(client, instrument, 'APPROVED', {
          actor: command.operatorId,
          reason: command.comment,
          correlationId: command.correlationId,
          passportVersion: BigInt(passport.version),
          occurredAt: decidedAt,
        });
      } else if (decision === 'REJECT' || decision === 'RETURN_FOR_REVISION') {
        await client.query(
          `
            UPDATE instrument_passport_versions
            SET review_state = $3, updated_at = $4
            WHERE instrument_id = $1 AND version = $2
          `,
          [
            instrument.id,
            passport.version,
            decision === 'REJECT' ? 'REJECTED' : 'RETURNED',
            decidedAt,
          ],
        );
      }

      return {
        instrument: mapInstrument(await this.readInstrument(client, instrument.id)),
        passportVersion: safeVersion(passport.version),
        decision,
        distinctApprovalCount: approvalCount,
      };
    });
  }

  private async transitionWithin(
    client: PoolClient,
    instrument: InstrumentRow,
    targetStatus: InstrumentStatus,
    context: {
      readonly actor: string;
      readonly reason: string;
      readonly correlationId: string;
      readonly passportVersion: bigint;
      readonly occurredAt: string;
      readonly sourceEventId?: string;
    },
  ): Promise<void> {
    if (!isInstrumentStatus(instrument.status)) {
      throw new Error(`Unknown persisted instrument status ${instrument.status}`);
    }
    const suspendedFrom = instrument.suspended_from_status;
    if (suspendedFrom !== null && !isInstrumentStatus(suspendedFrom)) {
      throw new Error(`Unknown persisted suspension origin ${suspendedFrom}`);
    }
    let next;
    try {
      next = transitionInstrument({ status: instrument.status, suspendedFrom }, targetStatus);
    } catch (error: unknown) {
      if (error instanceof InvalidInstrumentTransitionError) {
        throw invalidTransition(error.from, error.to);
      }
      throw error;
    }

    await client.query(
      `
        UPDATE instrument
        SET status = $2, suspended_from_status = $3, updated_at = $4
        WHERE id = $1
      `,
      [instrument.id, next.status, next.suspendedFrom, context.occurredAt],
    );
    const domainEvent = await this.appendDomainEvent(client, {
      eventType: 'INSTRUMENT_STATUS_CHANGED',
      topic: 'domain.instrument.status-changed.v1',
      instrumentId: instrument.id,
      actor: context.actor,
      reason: context.reason,
      correlationId: context.correlationId,
      occurredAt: context.occurredAt,
      payload: {
        fromStatus: instrument.status,
        toStatus: next.status,
        passportVersion: context.passportVersion.toString(),
        ...(context.sourceEventId === undefined ? {} : { sourceEventId: context.sourceEventId }),
      },
    });
    await client.query(
      `
        INSERT INTO instrument_status_transitions (
          event_id, instrument_id, passport_version, from_status, to_status,
          actor, reason, correlation_id, source_event_id, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        domainEvent.eventId,
        instrument.id,
        context.passportVersion.toString(),
        instrument.status,
        next.status,
        context.actor,
        context.reason,
        context.correlationId,
        context.sourceEventId ?? null,
        context.occurredAt,
      ],
    );
  }

  private async appendDomainEvent(
    client: PoolClient,
    input: {
      readonly eventType: string;
      readonly topic: string;
      readonly instrumentId: string;
      readonly actor: string;
      readonly reason: string;
      readonly correlationId: string;
      readonly occurredAt: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<DomainEventIdentity> {
    const nonceResult = await client.query<{ nonce: string } & QueryResultRow>(
      `SELECT nextval(pg_get_serial_sequence('event_log', 'id'))::text AS nonce`,
    );
    const nonce = requireRow(nonceResult.rows[0], 'Could not allocate domain event nonce').nonce;
    const eventId = randomUUID();
    const envelope = {
      eventId,
      nonce,
      eventType: input.eventType,
      schemaVersion: '1',
      occurredAt: input.occurredAt,
      actor: input.actor,
      reason: input.reason,
      payload: { instrumentId: input.instrumentId, ...input.payload },
    };
    await client.query(
      `
        INSERT INTO event_log (
          id, occurred_at, actor, event_type, aggregate_type,
          aggregate_id, correlation_id, payload
        )
        VALUES ($1, $2, $3, $4, 'INSTRUMENT', $5, $6, $7::jsonb)
      `,
      [
        nonce,
        input.occurredAt,
        input.actor,
        input.eventType,
        input.instrumentId,
        input.correlationId,
        JSON.stringify(envelope),
      ],
    );
    await client.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)', [
      input.topic,
      JSON.stringify(envelope),
    ]);
    return { eventId, nonce, occurredAt: input.occurredAt };
  }

  private async lockInstrument(client: PoolClient, instrumentId: string): Promise<InstrumentRow> {
    const result = await client.query<InstrumentRow>(
      `SELECT ${INSTRUMENT_COLUMNS} FROM instrument WHERE id = $1 FOR UPDATE`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InstrumentListingError(
        'RESOURCE_NOT_FOUND',
        `Instrument ${instrumentId} was not found`,
        404,
      );
    }
    return row;
  }

  private async readCollateralPositions(
    instrumentId: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await this.pool.query<CollateralPositionRow>(
      `SELECT asset_id, reserved::text, available::text, unit, verifier_proofs, updated_at
       FROM collateral_position WHERE instrument_id = $1 ORDER BY asset_id`,
      [instrumentId],
    );
    return result.rows.map((row) => ({
      assetId: row.asset_id,
      instrumentId,
      reserved: row.reserved,
      available: row.available,
      unit: row.unit,
      verifierProofs: row.verifier_proofs,
      updatedAt: toIso(row.updated_at),
    }));
  }

  private async readInstrument(
    executor: Pick<Pool | PoolClient, 'query'>,
    instrumentId: string,
  ): Promise<InstrumentRow> {
    const result = await executor.query<InstrumentRow>(
      `SELECT ${INSTRUMENT_COLUMNS} FROM instrument WHERE id = $1`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InstrumentListingError(
        'RESOURCE_NOT_FOUND',
        `Instrument ${instrumentId} was not found`,
        404,
      );
    }
    return row;
  }

  private async lockCurrentPassport(
    client: PoolClient,
    instrument: InstrumentRow,
  ): Promise<PassportRow> {
    const result = await client.query<PassportRow>(
      `
        SELECT version::text, passport, review_state, passport_hash, submitted_at, published_at
        FROM instrument_passport_versions
        WHERE instrument_id = $1 AND version = $2
        FOR UPDATE
      `,
      [instrument.id, instrument.version],
    );
    return requireRow(result.rows[0], `Passport version ${instrument.version} was not found`);
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

const INSTRUMENT_COLUMNS = `
  id::text,
  type,
  legal_nature::text,
  status::text,
  currency,
  unit,
  unit_per_token::text,
  supply_cap::text,
  circulating_supply::text,
  version::text,
  passport_hash,
  suspended_from_status::text,
  extensions,
  issuer_id,
  created_at,
  updated_at
`;

function mapInstrument(row: InstrumentRow): InstrumentView {
  if (!isInstrumentStatus(row.status)) {
    throw new Error(`Unknown persisted instrument status ${row.status}`);
  }
  return {
    id: row.id,
    type: row.type,
    legalNature: row.legal_nature,
    status: row.status,
    currency: row.currency,
    unit: row.unit,
    unitPerToken: row.unit_per_token,
    supplyCap: row.supply_cap,
    circulatingSupply: row.circulating_supply,
    version: safeVersion(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    extensions: row.extensions,
  };
}

function validateCreateDraft(command: CreateInstrumentDraftCommand): void {
  validateCommonCommand(randomUUID(), command.actorId, command.correlationId);
  if (!CODE_PATTERN.test(command.type)) throw validationError('type', 'type is invalid');
  if (!CURRENCY_PATTERN.test(command.currency)) {
    throw validationError('currency', 'currency must be a three-letter uppercase code');
  }
  if (!CODE_PATTERN.test(command.unit)) throw validationError('unit', 'unit is invalid');
  assertPositiveAmount(command.unitPerToken, 'unitPerToken');
  assertPositiveAmount(command.supplyCap, 'supplyCap');
  validatePassportAmounts(command.passport);
}

function validatePassportAmounts(passport: PassportDraft): void {
  if (passport.underlyingAsset?.quantity !== undefined) {
    assertPositiveAmount(passport.underlyingAsset.quantity, 'passport.underlyingAsset.quantity');
  }
  for (const [index, document] of (passport.underlyingAsset?.documents ?? []).entries()) {
    assertNonNegativeAmount(document.size, `passport.underlyingAsset.documents[${index}].size`);
  }
  if (passport.economics !== undefined) {
    assertPositiveAmount(passport.economics.issuePrice, 'passport.economics.issuePrice');
    if (passport.economics.collateralReserveBps !== undefined) {
      assertNonNegativeAmount(
        passport.economics.collateralReserveBps,
        'passport.economics.collateralReserveBps',
      );
    }
    for (const [index, fee] of passport.economics.feeSchedule.entries()) {
      assertNonNegativeAmount(fee.amount, `passport.economics.feeSchedule[${index}].amount`);
    }
  }
  if (passport.tradingParameters !== undefined) {
    assertPositiveAmount(
      passport.tradingParameters.tickSize,
      'passport.tradingParameters.tickSize',
    );
    assertPositiveAmount(passport.tradingParameters.lotSize, 'passport.tradingParameters.lotSize');
    assertPositiveAmount(
      passport.tradingParameters.minimumOrderQuantity,
      'passport.tradingParameters.minimumOrderQuantity',
    );
    assertPositiveAmount(
      passport.tradingParameters.minimumDeliveryQuantity,
      'passport.tradingParameters.minimumDeliveryQuantity',
    );
  }
  if (parsePassportDraft(passportToJson(passport)) === null) {
    throw validationError('passport', 'passport does not match TokenPassportDraft');
  }
}

function assertIssuer(instrument: InstrumentRow, issuerId: string): void {
  if (instrument.issuer_id !== issuerId) {
    throw new InstrumentListingError(
      'PERMISSION_DENIED',
      `Instrument ${instrument.id} is not owned by the authenticated issuer`,
      403,
    );
  }
}

function validateCommonCommand(instrumentId: string, actorId: string, correlationId: string): void {
  assertUuid(instrumentId, 'instrumentId');
  assertUuid(correlationId, 'correlationId');
  assertNonBlank(actorId, 'actorId');
}

function assertPositiveAmount(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_NUMERIC_38) {
    throw validationError(field, `${field} must be a positive bigint within NUMERIC(38,0)`);
  }
}

function assertNonNegativeAmount(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_NUMERIC_38) {
    throw validationError(field, `${field} must be a non-negative bigint within NUMERIC(38,0)`);
  }
}

function assertPositiveVersion(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw validationError('version', 'version must be a positive bigint');
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw validationError(field, `${field} must be a UUID`);
  }
}

function assertNonBlank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(field, `${field} must be a non-empty string`);
  }
}

function invalidTransition(from: string, to: InstrumentStatus): InstrumentListingError {
  return new InstrumentListingError(
    'INVALID_TRANSITION',
    `Instrument transition ${from} -> ${to} is not allowed`,
    409,
  );
}

function validationError(field: string, reason: string): InstrumentListingError {
  return new InstrumentListingError('VALIDATION_ERROR', reason, 400, [{ field, reason }]);
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`Instrument version ${value} cannot be represented safely`);
  }
  return version;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeMarketCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

function decodeMarketCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      value === null ||
      typeof value !== 'object' ||
      !('createdAt' in value) ||
      !('id' in value) ||
      typeof value.createdAt !== 'string' ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.id !== 'string' ||
      !UUID_PATTERN.test(value.id)
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: new Date(value.createdAt).toISOString(), id: value.id };
  } catch {
    throw validationError('cursor', 'cursor is invalid');
  }
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

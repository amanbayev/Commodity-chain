import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { CollateralCoverageConsumer } from './collateral-coverage.consumer.js';
import { InstrumentListingService } from './instrument-listing.service.js';
import type { CreateInstrumentDraftCommand } from './instrument-listing.types.js';
import type { PassportDraft } from './instrument-passport.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('instrument listing workflow', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
  const collateral = new PostgresCollateralLedger(pool);
  const service = new InstrumentListingService(pool, collateral);
  const collateralConsumer = new CollateralCoverageConsumer(service);
  let oracleNonce = 0n;

  beforeEach(async () => {
    oracleNonce = 0n;
    await pool.query(`
      TRUNCATE
        instrument_review_decisions,
        instrument_status_transitions,
        instrument_passport_versions,
        collateral_position_movements,
        collateral_position,
        oracle_events,
        outbox,
        event_log,
        asset,
        instrument,
        party
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reports every missing passport section and leaves the aggregate in DRAFT', async () => {
    const draft = await service.createDraft(draftCommand({}));

    await expect(
      service.submit({
        instrumentId: draft.instrument.id,
        version: 1n,
        actorId: 'issuer-1',
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'PASSPORT_INCOMPLETE',
      details: [
        { field: 'passport.underlyingAsset' },
        { field: 'passport.holderRights' },
        { field: 'passport.custodyAndVerification' },
        { field: 'passport.economics' },
        { field: 'passport.tradingParameters' },
      ],
    });

    expect(await instrumentStatus(draft.instrument.id)).toBe('DRAFT');
  });

  it('updates and lists only the issuer own draft', async () => {
    const draft = await service.createDraft(draftCommand({}));
    const updated = await service.updateDraft({
      ...draftCommand(completePassport()),
      instrumentId: draft.instrument.id,
      version: 1n,
      supplyCap: 5_000n,
      extensions: { ticker: 'WHT-3-2026', name: 'Пшеница 3 класса' },
    });

    expect(updated.instrument.supplyCap).toBe(5_000n);
    const page = await service.listIssuerInstruments('issuer-1', undefined, 20);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.instrument.id).toBe(draft.instrument.id);
    expect(page.items[0]?.passport).toEqual(updated.passport);

    await expect(
      service.getIssuerInstrument(draft.instrument.id, 'issuer-2'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('requires two different operators and keeps review comments out of the public passport', async () => {
    const submitted = await createSubmitted();
    const first = await service.approve(
      review(submitted.instrument.id, 'operator-a', 'first-secret'),
    );
    expect(first.distinctApprovalCount).toBe(1);
    expect(first.instrument.status).toBe('UNDER_REVIEW');

    await expect(
      service.approve(review(submitted.instrument.id, 'operator-a', 'duplicate-secret')),
    ).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });

    const second = await service.approve(
      review(submitted.instrument.id, 'operator-b', 'second-secret'),
    );
    expect(second.instrument.status).toBe('APPROVED');
    const publicPassport = await service.getPublicPassport(submitted.instrument.id);
    expect(publicPassport.passportHash).toBe(submitted.passportHash);
    expect(JSON.stringify(publicPassport.passport)).not.toContain('first-secret');
    expect(JSON.stringify(publicPassport.passport)).not.toContain('second-secret');
  });

  it('creates a new version and hash after return for revision without reversing aggregate state', async () => {
    const submitted = await createSubmitted();
    await service.returnForRevision(
      review(submitted.instrument.id, 'operator-a', 'clarify holder claim'),
    );
    const revisedPassport = completePassport({ claimDescription: 'Revised grain claim' });
    const revised = await service.revisePassport({
      instrumentId: submitted.instrument.id,
      passport: revisedPassport,
      actorId: 'issuer-1',
      reason: 'Review feedback incorporated',
      correlationId: randomUUID(),
    });
    expect(revised.version).toBe(2);
    expect(revised.instrument.status).toBe('UNDER_REVIEW');

    const resubmitted = await service.submit({
      instrumentId: submitted.instrument.id,
      version: 2n,
      actorId: 'issuer-1',
      correlationId: randomUUID(),
    });
    expect(resubmitted.passportHash).not.toBe(submitted.passportHash);
    expect(resubmitted.version).toBe(2);
  });

  it('promotes APPROVED to COLLATERALIZED only from a sufficient collateral outbox event', async () => {
    const submitted = await createSubmitted();
    await service.approve(review(submitted.instrument.id, 'operator-a', 'approved'));
    await service.approve(review(submitted.instrument.id, 'operator-b', 'approved'));
    await expect(
      service.transition({
        instrumentId: submitted.instrument.id,
        targetStatus: 'COLLATERALIZED',
        actorId: 'listing-operator',
        reason: 'Manual bypass attempt',
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    const fixture = await createAsset(submitted.instrument.id, 100n);
    const oracleEventId = await createOracleEvent(fixture, 100n);
    await collateral.reserve(fixture.assetId, submitted.instrument.id, 100n, oracleEventId);

    const message = await pool.query<{
      payload: {
        eventId: string;
        nonce: string;
        instrumentId: string;
        correlationId: string;
      };
    }>(
      `SELECT payload FROM outbox WHERE topic = 'domain.collateral.reserved.v1' ORDER BY id DESC LIMIT 1`,
    );
    const event = message.rows[0]?.payload;
    if (event === undefined) throw new Error('Collateral outbox event was not emitted');

    expect(await collateralConsumer.handle(event)).toBe(true);
    expect(await collateralConsumer.handle(event)).toBe(false);
    expect(await instrumentStatus(submitted.instrument.id)).toBe('COLLATERALIZED');

    const lifecycleCorrelationId = randomUUID();
    const primary = await service.transition({
      instrumentId: submitted.instrument.id,
      targetStatus: 'PRIMARY',
      actorId: 'listing-operator',
      reason: 'Primary distribution opened',
      correlationId: lifecycleCorrelationId,
    });
    expect(primary.status).toBe('PRIMARY');

    const effects = await pool.query<{
      transitions: string;
      audits: string;
      messages: string;
      actor: string;
      reason: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM instrument_status_transitions
            WHERE source_event_id::text = $1)::text AS transitions,
          (SELECT count(*) FROM event_log
            WHERE event_type = 'INSTRUMENT_STATUS_CHANGED'
              AND payload -> 'payload' ->> 'sourceEventId' = $1)::text AS audits,
          (SELECT count(*) FROM outbox
            WHERE topic = 'domain.instrument.status-changed.v1'
              AND payload -> 'payload' ->> 'sourceEventId' = $1)::text AS messages
          ,(SELECT actor FROM instrument_status_transitions
            WHERE correlation_id = $2) AS actor
          ,(SELECT reason FROM instrument_status_transitions
            WHERE correlation_id = $2) AS reason
      `,
      [event.eventId, lifecycleCorrelationId],
    );
    expect(effects.rows[0]).toEqual({
      transitions: '1',
      audits: '1',
      messages: '1',
      actor: 'listing-operator',
      reason: 'Primary distribution opened',
    });
  });

  async function createSubmitted() {
    const draft = await service.createDraft(draftCommand(completePassport()));
    return service.submit({
      instrumentId: draft.instrument.id,
      version: 1n,
      actorId: 'issuer-1',
      correlationId: randomUUID(),
    });
  }

  async function instrumentStatus(instrumentId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      'SELECT status::text FROM instrument WHERE id = $1',
      [instrumentId],
    );
    return result.rows[0]?.status ?? '';
  }

  async function createAsset(instrumentId: string, quantity: bigint) {
    const ownerId = randomUUID();
    const assetId = `asset-${randomUUID()}`;
    await pool.query('INSERT INTO party (id, external_id) VALUES ($1, $2)', [
      ownerId,
      `party-${ownerId}`,
    ]);
    await pool.query(
      `
        INSERT INTO asset (
          asset_id, class, owner_party_id, quantity, unit, location, encumbrance_status
        ) VALUES ($1, 'GRAIN', $2, $3, 'GRAM', 'ELEVATOR-1', 'FREE')
      `,
      [assetId, ownerId, quantity.toString()],
    );
    return { instrumentId, assetId };
  }

  async function createOracleEvent(
    fixture: { instrumentId: string; assetId: string },
    quantity: bigint,
  ): Promise<string> {
    oracleNonce += 1n;
    const eventId = randomUUID();
    await pool.query(
      `
        INSERT INTO oracle_events (
          source_id, event_id, schema_version, instrument_id, asset_id, event_type,
          quantity, unit, observed_at, effective_at, evidence_hash, nonce, signature,
          status, correlation_id, raw_payload, http_status, response_body, applied_at
        ) VALUES (
          'instrument-listing-test', $1, '1', $2, $3, 'RECEIPT_LOCKED', $4, 'GRAM',
          now(), now(), 'sha256:0123456789abcdef', $5, '{}'::jsonb, 'APPLIED', $6,
          '{}'::jsonb, 202, '{}'::jsonb, now()
        )
      `,
      [
        eventId,
        fixture.instrumentId,
        fixture.assetId,
        quantity.toString(),
        oracleNonce.toString(),
        randomUUID(),
      ],
    );
    return eventId;
  }
});

function review(instrumentId: string, operatorId: string, comment: string) {
  return { instrumentId, operatorId, comment, correlationId: randomUUID() };
}

function draftCommand(passport: PassportDraft): CreateInstrumentDraftCommand {
  return {
    type: 'GRAIN_TOKEN',
    legalNature: 'CLAIM_RIGHT',
    currency: 'KZT',
    unit: 'GRAM',
    unitPerToken: 1n,
    supplyCap: 100n,
    passport,
    actorId: 'issuer-1',
    correlationId: randomUUID(),
  };
}

function completePassport(overrides: { readonly claimDescription?: string } = {}): PassportDraft {
  return {
    underlyingAsset: {
      assetClass: 'GRAIN',
      commodity: 'Wheat',
      grade: 'Class 3',
      originCountry: 'KZ',
      unit: 'GRAM',
      storageLocation: 'Elevator 1',
    },
    holderRights: {
      legalTitle: 'CLAIM_RIGHT',
      claimDescription: overrides.claimDescription ?? 'Claim secured by an electronic receipt',
      governingLaw: 'AIFC law',
      redemptionMethods: ['PHYSICAL_DELIVERY'],
      transferRestrictions: [],
    },
    custodyAndVerification: {
      custodianId: 'custodian-1',
      registryId: 'ezr-registry',
      verifierIds: ['verifier-1'],
    },
    economics: {
      issuePrice: 100n,
      issueCurrency: 'KZT',
      maturityDate: '2027-08-14',
      feeSchedule: [{ feeType: 'REDEMPTION', amount: 1n, currency: 'KZT' }],
    },
    tradingParameters: {
      tickSize: 1n,
      lotSize: 1n,
      minimumOrderQuantity: 1n,
      minimumDeliveryQuantity: 1n,
      settlementCycle: 'T_PLUS_1',
    },
  };
}

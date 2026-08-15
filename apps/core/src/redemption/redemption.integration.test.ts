import { generateKeyPairSync, randomUUID } from 'node:crypto';

import {
  PostgresEzrRegistry,
  verifyOracleEventSignature,
  type OracleEventEnvelope,
  type OracleEventPublisher,
} from '@commodity-chain/adapters';
import { PostgresLedger, type LedgerAccountId } from '@commodity-chain/ledger';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcileSupply } from '../../../../ops/reconcile-supply.js';
import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { RedemptionTokensLockedConsumer } from './redemption.consumers.js';
import { RedemptionService } from './redemption.service.js';

type RedemptionOracleEnvelope = OracleEventEnvelope & { readonly redemptionId?: string };

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('redemption PostgreSQL integration', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
  const ledger = new PostgresLedger(pool);
  const collateral = new PostgresCollateralLedger(pool);
  const service = new RedemptionService(pool, ledger, collateral);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        redemption_transitions,
        redemption_orders,
        settlement_transitions,
        settlement_account_snapshots,
        settlement_system_accounts,
        order_commands,
        matching_events,
        settlement_fees,
        settlements,
        trades,
        orders,
        fee_schedules,
        matching_books,
        oms_clearing_accounts,
        mint_commands,
        instrument_token_accounts,
        instrument_review_decisions,
        instrument_status_transitions,
        instrument_passport_versions,
        collateral_position_movements,
        collateral_position,
        mock_ezr_http_outbox,
        mock_ezr_source_counters,
        mock_ezr_receipts,
        oracle_events,
        trusted_sources,
        outbox,
        event_log,
        ledger_entries,
        ledger_postings,
        ledger_accounts,
        asset,
        instrument,
        party
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => pool.end());

  it('completes evidenced delivery once across 100 oracle replays', async () => {
    const fixture = await setupFixture(100n);
    const created = await service.create(command(fixture, 100n, 'one-burn'));
    expect(created.httpStatus).toBe(202);
    if ('code' in created.body) throw new Error(created.body.message);
    const redemptionId = created.body.id;

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let releasedEnvelope: RedemptionOracleEnvelope | undefined;
    const publisher: OracleEventPublisher = {
      publish: (envelope) => {
        releasedEnvelope = envelope as RedemptionOracleEnvelope;
        return Promise.resolve({
          eventId: envelope.eventId,
          acceptedAt: new Date().toISOString(),
          status: 'APPLIED',
          replayed: false,
        });
      },
    };
    const registry = new PostgresEzrRegistry({
      pool,
      sourceId: 'ezr-redemption-test',
      keyId: 'key-1',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      oraclePublisher: publisher,
      instrumentIdForReceipt: () => fixture.instrumentId,
      unitForCommodity: () => 'GRAM',
    });
    await pool.query(
      `INSERT INTO mock_ezr_receipts (
         receipt_id, owner, commodity, quantity, unit, elevator_id, status, instrument_id
       ) VALUES ($1, $2, 'WHEAT', 100, 'GRAM', 'elevator-1', 'LOCKED', $3)`,
      [fixture.assetId, fixture.holderId, fixture.instrumentId],
    );
    await new RedemptionTokensLockedConsumer(service, registry).handle({
      redemptionId,
      instrumentId: fixture.instrumentId,
      quantity: '100',
      correlationId: randomUUID(),
    });
    expect(releasedEnvelope?.redemptionId).toBe(redemptionId);
    if (releasedEnvelope === undefined) throw new Error('Mock EZR did not emit GOODS_RELEASED');
    expect(
      verifyOracleEventSignature(
        releasedEnvelope,
        publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ),
    ).toBe(true);
    await insertAppliedOracle(releasedEnvelope, randomUUID());
    const applied = {
      ...releasedEnvelope,
      correlationId: randomUUID(),
    };
    await Promise.all(Array.from({ length: 100 }, () => service.applyGoodsReleased(applied)));

    expect(await ledger.balanceOf(fixture.holderAvailable)).toBe(0n);
    expect(await ledger.balanceOf(fixture.holderReserved)).toBe(0n);
    expect(await ledger.balanceOf(fixture.distribution)).toBe(0n);
    const state = await pool.query<{ supply: string; collateral: string; burns: string }>(
      `SELECT instrument.circulating_supply::text AS supply,
              position.reserved::text AS collateral,
              (SELECT count(*) FROM ledger_postings
               WHERE metadata ->> 'operation' = 'REDEMPTION_BURN')::text AS burns
       FROM instrument
       JOIN collateral_position AS position ON position.instrument_id = instrument.id
       WHERE instrument.id = $1`,
      [fixture.instrumentId],
    );
    expect(state.rows[0]).toMatchObject({ supply: '0', collateral: '0', burns: '1' });
    expect((await reconcileSupply(pool)).consistent).toBe(true);
  });

  it('cancels before dispatch and releases tokens idempotently', async () => {
    const fixture = await setupFixture(20n);
    const created = await service.create(command(fixture, 20n, 'cancel'));
    if ('code' in created.body) throw new Error(created.body.message);
    const first = await service.cancel({
      redemptionId: created.body.id,
      holderId: fixture.holderId,
      correlationId: randomUUID(),
    });
    const second = await service.cancel({
      redemptionId: created.body.id,
      holderId: fixture.holderId,
      correlationId: randomUUID(),
    });
    expect(first.body).toMatchObject({ status: 'CANCELLED' });
    expect(second.replayed).toBe(true);
    expect(await ledger.balanceOf(fixture.holderAvailable)).toBe(20n);
    expect(await ledger.balanceOf(fixture.holderReserved)).toBe(0n);
  });

  it('quarantines a quantity mismatch without burning or releasing', async () => {
    const fixture = await setupFixture(20n);
    const created = await service.create(command(fixture, 20n, 'mismatch'));
    if ('code' in created.body) throw new Error(created.body.message);
    await insertLockedReceipt(fixture);
    await service.prepareDelivery(created.body.id, randomUUID());
    const eventId = randomUUID();
    await insertAppliedOracle(
      {
        eventId,
        schemaVersion: '1',
        instrumentId: fixture.instrumentId,
        assetId: fixture.assetId,
        eventType: 'GOODS_RELEASED',
        quantity: '19',
        unit: 'GRAM',
        observedAt: new Date().toISOString(),
        effectiveAt: new Date().toISOString(),
        sourceId: 'ezr-redemption-test',
        redemptionId: created.body.id,
        evidenceHash: 'sha256:mismatch',
        nonce: 1,
        signature: { algorithm: 'Ed25519', keyId: 'key-1', value: 'test' },
      } satisfies RedemptionOracleEnvelope,
      randomUUID(),
    );
    const result = await service.applyGoodsReleased({
      eventId,
      instrumentId: fixture.instrumentId,
      assetId: fixture.assetId,
      eventType: 'GOODS_RELEASED',
      quantity: '19',
      redemptionId: created.body.id,
      correlationId: randomUUID(),
    });
    expect(result.status).toBe('QUARANTINED');
    expect(await ledger.balanceOf(fixture.holderReserved)).toBe(20n);
    expect(await collateral.verifiedAvailable(fixture.instrumentId)).toBe(20n);
  });

  it('replays 100 identical POST requests as one redemption and one reserve', async () => {
    const fixture = await setupFixture(20n);
    const request = command(fixture, 20n, 'post-replay');
    const results = await Promise.all(Array.from({ length: 100 }, () => service.create(request)));
    expect(
      new Set(results.map((result) => ('code' in result.body ? '' : result.body.id))).size,
    ).toBe(1);
    const counts = await pool.query<{ redemptions: string; reserves: string }>(
      `SELECT
         (SELECT count(*) FROM redemption_orders)::text AS redemptions,
         (SELECT count(*) FROM ledger_postings
          WHERE metadata ->> 'operation' = 'REDEMPTION_RESERVE')::text AS reserves`,
    );
    expect(counts.rows[0]).toEqual({ redemptions: '1', reserves: '1' });
  });

  it('moves overdue delivery to EXCEPTION while keeping holder tokens reserved', async () => {
    const fixture = await setupFixture(20n);
    const created = await service.create(command(fixture, 20n, 'timeout'));
    if ('code' in created.body) throw new Error(created.body.message);
    const expiry = new RedemptionService(pool, ledger, collateral, {
      now: () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
    });
    expect(await expiry.expireOverdue()).toBe(1);
    const state = await pool.query<{ status: string; incidents: string }>(
      `SELECT status::text,
              (SELECT count(*) FROM event_log WHERE event_type = 'INCIDENT')::text AS incidents
       FROM redemption_orders WHERE id = $1`,
      [created.body.id],
    );
    expect(state.rows[0]).toEqual({ status: 'EXCEPTION', incidents: '1' });
    expect(await ledger.balanceOf(fixture.holderReserved)).toBe(20n);
    expect(await ledger.balanceOf(fixture.holderAvailable)).toBe(0n);
  });

  it('rejects a database transition out of COMPLETED', async () => {
    const fixture = await setupFixture(20n);
    const created = await service.create(command(fixture, 20n, 'immutable'));
    if ('code' in created.body) throw new Error(created.body.message);
    await insertLockedReceipt(fixture);
    await service.prepareDelivery(created.body.id, randomUUID());
    const event = {
      eventId: randomUUID(),
      schemaVersion: '1',
      instrumentId: fixture.instrumentId,
      assetId: fixture.assetId,
      eventType: 'GOODS_RELEASED' as const,
      quantity: '20',
      unit: 'GRAM',
      observedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      sourceId: 'ezr-redemption-test',
      redemptionId: created.body.id,
      evidenceHash: 'sha256:immutable',
      nonce: 1,
      signature: { algorithm: 'Ed25519' as const, keyId: 'key-1', value: 'test' },
    };
    await insertAppliedOracle(event, randomUUID());
    await service.applyGoodsReleased({ ...event, correlationId: randomUUID() });
    await expect(
      pool.query("UPDATE redemption_orders SET status = 'IN_DELIVERY' WHERE id = $1", [
        created.body.id,
      ]),
    ).rejects.toThrow(/INVALID_REDEMPTION_TRANSITION/u);
  });

  async function setupFixture(quantity: bigint) {
    const holderId = randomUUID();
    const issuerId = randomUUID();
    const fundingId = randomUUID();
    for (const id of [holderId, issuerId, fundingId]) {
      await pool.query('INSERT INTO party (id, external_id) VALUES ($1, $2)', [id, `p-${id}`]);
    }
    const instrumentId = randomUUID();
    await pool.query(
      `INSERT INTO instrument (
         id, type, legal_nature, status, currency, unit, unit_per_token,
         supply_cap, circulating_supply, version
       ) VALUES ($1, 'GRAIN_TOKEN', 'CLAIM_RIGHT', 'ACTIVE', 'KZT', 'GRAM', 1, $2, $2, 1)`,
      [instrumentId, quantity.toString()],
    );
    await pool.query(
      `INSERT INTO instrument_passport_versions (
         instrument_id, version, passport, review_state, passport_hash,
         submitted_at, published_at, created_by
       ) VALUES ($1, 1, $2::jsonb, 'APPROVED', $3, now(), now(), 'test')`,
      [
        instrumentId,
        JSON.stringify({ tradingParameters: { minimumDeliveryQuantity: '10' } }),
        `sha256:${'a'.repeat(64)}`,
      ],
    );
    const assetId = randomUUID();
    await pool.query(
      `INSERT INTO asset (
         asset_id, class, owner_party_id, quantity, unit, location, encumbrance_status
       ) VALUES ($1, 'GRAIN', $2, $3, 'GRAM', 'elevator-1', 'LOCKED')`,
      [assetId, issuerId, quantity.toString()],
    );
    await pool.query(
      `INSERT INTO collateral_position (
         asset_id, instrument_id, reserved, available, unit
       ) VALUES ($1, $2, $3, 0, 'GRAM')`,
      [assetId, instrumentId, quantity.toString()],
    );
    const holderAvailable = await openToken(holderId, instrumentId, 'AVAILABLE');
    const holderReserved = await openToken(holderId, instrumentId, 'RESERVED');
    const distribution = await openToken(issuerId, instrumentId, 'AVAILABLE', 'CREDIT');
    const issuance = await openToken(issuerId, instrumentId, 'RESIDUAL');
    const allocation = await openToken(fundingId, instrumentId, 'RESIDUAL', 'CREDIT');
    await pool.query(
      `INSERT INTO instrument_token_accounts (
         instrument_id, distribution_account_id, issuance_account_id
       ) VALUES ($1, $2, $3)`,
      [instrumentId, distribution, issuance],
    );
    await ledger.post({
      idempotencyKey: `mint-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: issuance, direction: 'DEBIT', amount: quantity },
        { accountId: distribution, direction: 'CREDIT', amount: quantity },
      ],
    });
    await ledger.post({
      idempotencyKey: `allocation-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: holderAvailable, direction: 'DEBIT', amount: quantity },
        { accountId: allocation, direction: 'CREDIT', amount: quantity },
      ],
    });
    return {
      holderId,
      instrumentId,
      assetId,
      holderAvailable,
      holderReserved,
      distribution,
    };
  }

  async function openToken(
    ownerId: string,
    instrumentId: string,
    purpose: 'AVAILABLE' | 'RESERVED' | 'RESIDUAL',
    normalSide: 'DEBIT' | 'CREDIT' = 'DEBIT',
  ): Promise<LedgerAccountId> {
    return (
      await ledger.openAccount({ ownerId, accountType: 'TOKEN', instrumentId, purpose, normalSide })
    ).id;
  }

  function command(
    fixture: { holderId: string; instrumentId: string },
    quantity: bigint,
    suffix: string,
  ) {
    return {
      holderId: fixture.holderId,
      instrumentId: fixture.instrumentId,
      quantity,
      method: 'PHYSICAL_DELIVERY' as const,
      delivery: {
        elevatorId: 'elevator-1',
        requestedDate: '2026-08-20',
        recipient: 'Holder',
        transport: 'Truck KZ-001',
      },
      proofs: [],
      idempotencyKey: `redemption-${suffix}`,
      correlationId: randomUUID(),
    };
  }

  async function insertLockedReceipt(fixture: {
    holderId: string;
    instrumentId: string;
    assetId: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO mock_ezr_receipts (
         receipt_id, owner, commodity, quantity, unit, elevator_id, status, instrument_id
       ) VALUES ($1, $2, 'WHEAT', 20, 'GRAM', 'elevator-1', 'LOCKED', $3)`,
      [fixture.assetId, fixture.holderId, fixture.instrumentId],
    );
  }

  async function insertAppliedOracle(
    envelope: RedemptionOracleEnvelope,
    correlationId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO oracle_events (
         source_id, event_id, schema_version, instrument_id, asset_id, event_type,
         quantity, unit, observed_at, effective_at, evidence_hash, nonce, signature,
         status, correlation_id, raw_payload, http_status, response_body, applied_at,
         redemption_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
         'APPLIED', $14, $15::jsonb, 202, $16::jsonb, now(), $17
       )`,
      [
        envelope.sourceId,
        envelope.eventId,
        envelope.schemaVersion,
        envelope.instrumentId,
        envelope.assetId,
        envelope.eventType,
        envelope.quantity,
        envelope.unit,
        envelope.observedAt,
        envelope.effectiveAt,
        envelope.evidenceHash,
        envelope.nonce,
        JSON.stringify(envelope.signature),
        correlationId,
        JSON.stringify(envelope),
        JSON.stringify({ eventId: envelope.eventId, status: 'APPLIED' }),
        envelope.redemptionId ?? null,
      ],
    );
  }
});

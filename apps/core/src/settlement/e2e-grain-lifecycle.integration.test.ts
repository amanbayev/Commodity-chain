import { randomUUID } from 'node:crypto';

import { PostgresLedger, type LedgerAccountId } from '@commodity-chain/ledger';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcileSettlements } from '../../../../ops/reconcile-settlements.js';
import { reconcileSupply } from '../../../../ops/reconcile-supply.js';
import { AppliedOracleEventConsumer } from '../collateral/applied-oracle-event.consumer.js';
import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { CollateralCoverageConsumer } from '../instrument/collateral-coverage.consumer.js';
import { InstrumentListingService } from '../instrument/instrument-listing.service.js';
import type { CreateInstrumentDraftCommand } from '../instrument/instrument-listing.types.js';
import type { PassportDraft } from '../instrument/instrument-passport.js';
import { MintService } from '../instrument/mint.service.js';
import { InstrumentCommandQueue } from '../oms/instrument-command-queue.js';
import { OmsService } from '../oms/oms.service.js';
import type { OrderView, PlaceOrderCommand } from '../oms/oms.types.js';
import { RedemptionService } from '../redemption/redemption.service.js';
import { SettlementCreatedConsumer } from './settlement-created.consumer.js';
import { SettlementService } from './settlement.service.js';
import type { SettlementCreatedDomainEvent } from './settlement.types.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('e2e-grain-lifecycle', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
  const ledger = new PostgresLedger(pool);
  const collateral = new PostgresCollateralLedger(pool);

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

  afterAll(async () => {
    await pool.end();
  });

  it('lists, collateralizes, mints, trades, settles, and reconciles one grain token', async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    const clearingId = randomUUID();
    const exchangeId = randomUUID();
    const fundingId = randomUUID();
    const issuerId = randomUUID();
    await insertParties([sellerId, buyerId, clearingId, exchangeId, fundingId, issuerId]);

    const listing = new InstrumentListingService(pool, collateral);
    const draft = await listing.createDraft(draftCommand());
    const instrumentId = draft.instrument.id;
    await listing.submit({
      instrumentId,
      version: 1n,
      actorId: 'grain-issuer',
      correlationId: randomUUID(),
    });
    await listing.approve({
      instrumentId,
      operatorId: 'listing-operator-a',
      comment: 'Legal review passed',
      correlationId: randomUUID(),
    });
    await listing.approve({
      instrumentId,
      operatorId: 'listing-operator-b',
      comment: 'Risk review passed',
      correlationId: randomUUID(),
    });

    const assetId = randomUUID();
    await pool.query(
      `INSERT INTO asset (
         asset_id, class, owner_party_id, quantity, unit, location, encumbrance_status
       ) VALUES ($1, 'GRAIN', $2, 100, 'GRAM', 'ELEVATOR-E2E', 'FREE')`,
      [assetId, sellerId],
    );
    const oracleEventId = randomUUID();
    const oracleCorrelationId = randomUUID();
    await pool.query(
      `INSERT INTO oracle_events (
         source_id, event_id, schema_version, instrument_id, asset_id, event_type,
         quantity, unit, observed_at, effective_at, evidence_hash, nonce, signature,
         status, correlation_id, raw_payload, http_status, response_body, applied_at
       ) VALUES (
         'e2e-ezr', $1, '1', $2, $3, 'RECEIPT_LOCKED', 100, 'GRAM', now(), now(),
         'sha256:e2e0123456789abcdef', 1, '{}'::jsonb, 'APPLIED', $4,
         '{}'::jsonb, 202, '{}'::jsonb, now()
       )`,
      [oracleEventId, instrumentId, assetId, oracleCorrelationId],
    );
    await new AppliedOracleEventConsumer(collateral).handle({
      eventId: oracleEventId,
      instrumentId,
      assetId,
      eventType: 'RECEIPT_LOCKED',
      quantity: '100',
    });
    const collateralOutbox = await pool.query<{
      payload: { eventId: string; nonce: string; instrumentId: string; correlationId: string };
    }>(
      `SELECT payload FROM outbox
       WHERE topic = 'domain.collateral.reserved.v1' ORDER BY created_at DESC LIMIT 1`,
    );
    const collateralEvent = collateralOutbox.rows[0]?.payload;
    if (collateralEvent === undefined) throw new Error('Collateral event was not emitted');
    await new CollateralCoverageConsumer(listing).handle(collateralEvent);
    expect(await instrumentStatus(instrumentId)).toBe('COLLATERALIZED');

    const distribution = await ledger.openAccount({
      ownerId: issuerId,
      accountType: 'TOKEN',
      instrumentId,
      purpose: 'AVAILABLE',
      normalSide: 'CREDIT',
    });
    const issuance = await ledger.openAccount({
      ownerId: issuerId,
      accountType: 'TOKEN',
      instrumentId,
      purpose: 'RESIDUAL',
      normalSide: 'DEBIT',
    });
    await pool.query(
      `INSERT INTO instrument_token_accounts (
         instrument_id, distribution_account_id, issuance_account_id
       ) VALUES ($1, $2, $3)`,
      [instrumentId, distribution.id, issuance.id],
    );
    const mint = await new MintService(pool, collateral).execute({
      instrumentId,
      quantity: 100n,
      unit: 'GRAM',
      collateralProof: {
        assetId,
        instrumentId,
        reserved: '100',
        unit: 'GRAM',
        evidenceHash: 'sha256:e2e0123456789abcdef',
        verifierProofs: [{ verifierId: 'e2e-ezr' }],
      },
      idempotencyKey: `e2e-mint-${randomUUID()}`,
      correlationId: randomUUID(),
    });
    expect(mint.httpStatus).toBe(201);
    await listing.transition({
      instrumentId,
      targetStatus: 'PRIMARY',
      actorId: 'listing-operator-a',
      reason: 'Primary market opened after mint',
      correlationId: randomUUID(),
    });

    const buyerCash = await openCash(buyerId, 'AVAILABLE');
    await openCash(buyerId, 'RESERVED');
    const buyerTokens = await openToken(buyerId, instrumentId, 'AVAILABLE');
    const buyerReservedTokens = await openToken(buyerId, instrumentId, 'RESERVED');
    const sellerCash = await openCash(sellerId, 'AVAILABLE');
    const sellerTokens = await openToken(sellerId, instrumentId, 'AVAILABLE');
    await openToken(sellerId, instrumentId, 'RESERVED');
    const tokenAllocation = await openToken(fundingId, instrumentId, 'RESIDUAL', 'CREDIT');
    const cashFunding = await openCash(fundingId, 'RESIDUAL', 'CREDIT');
    await ledger.post({
      idempotencyKey: `e2e-token-allocation-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: sellerTokens, direction: 'DEBIT', amount: 100n },
        { accountId: tokenAllocation, direction: 'CREDIT', amount: 100n },
      ],
    });
    await ledger.post({
      idempotencyKey: `e2e-cash-funding-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: buyerCash, direction: 'DEBIT', amount: 100_000n },
        { accountId: cashFunding, direction: 'CREDIT', amount: 100_000n },
      ],
    });
    const clearingCash = await openCash(clearingId, 'RESERVED');
    const clearingToken = await openToken(clearingId, instrumentId, 'RESERVED');
    const feeAccount = await openCash(exchangeId, 'FEE');
    const residualAccount = await openCash(exchangeId, 'RESIDUAL');
    await pool.query(
      `INSERT INTO oms_clearing_accounts (
         instrument_id, cash_reserved_account_id, token_reserved_account_id
       ) VALUES ($1, $2, $3)`,
      [instrumentId, clearingCash, clearingToken],
    );
    await pool.query(
      `INSERT INTO settlement_system_accounts (currency, fee_account_id, residual_account_id)
       VALUES ('KZT', $1, $2)`,
      [feeAccount, residualAccount],
    );
    await pool.query(
      `INSERT INTO fee_schedules (
         instrument_id, version, currency, maker_rate_ppm, taker_rate_ppm, effective_from
       ) VALUES ($1, 1, 'KZT', 500, 1000, now() - interval '1 day')`,
      [instrumentId],
    );

    const oms = new OmsService(pool, ledger, new InstrumentCommandQueue());
    await oms.place(order(sellerId, instrumentId, 'SELL', 'e2e-sell'));
    const buy = orderResult(await oms.place(order(buyerId, instrumentId, 'BUY', 'e2e-buy')));
    const settlementId = buy.trades[0]?.tradeId;
    if (settlementId === undefined) throw new Error('E2E trade was not created');
    const settlementOutbox = await pool.query<{ payload: SettlementCreatedDomainEvent }>(
      `SELECT payload FROM outbox
       WHERE topic = 'domain.settlement.created.v1' AND payload ->> 'tradeId' = $1`,
      [settlementId],
    );
    const settlementEvent = settlementOutbox.rows[0]?.payload;
    if (settlementEvent === undefined) throw new Error('Settlement event was not emitted');
    await new SettlementCreatedConsumer(new SettlementService(pool, ledger)).handle(
      settlementEvent,
    );

    const settlementReport = await reconcileSettlements(pool);
    const supplyReport = await reconcileSupply(pool);
    expect(settlementReport.consistent).toBe(true);
    expect(supplyReport.consistent).toBe(true);
    expect(await instrumentStatus(instrumentId)).toBe('PRIMARY');
    expect(await ledger.balanceOf(buyerTokens)).toBe(100n);
    expect(await ledger.balanceOf(sellerTokens)).toBe(0n);
    expect(await ledger.balanceOf(sellerCash)).toBe(9_995n);
    expect(await ledger.balanceOf(feeAccount)).toBe(15n);
    expect(await ledger.balanceOf(residualAccount)).toBe(0n);
    expect((await ledger.trialBalance()).balanced).toBe(true);
    const final = await pool.query<{
      status: string;
      supply: string;
      collateral: string;
      events: string;
    }>(
      `SELECT
         settlement.finality_status::text AS status,
         instrument.circulating_supply::text AS supply,
         collateral.reserved::text AS collateral,
         (SELECT count(*) FROM event_log)::text AS events
       FROM settlements AS settlement
       JOIN instrument ON instrument.id = settlement.token_instrument_id
       JOIN collateral_position AS collateral ON collateral.instrument_id = instrument.id
       WHERE settlement.trade_id = $1`,
      [settlementId],
    );
    expect(final.rows[0]).toMatchObject({ status: 'RECONCILED', supply: '100', collateral: '100' });
    expect(BigInt(final.rows[0]?.events ?? '0')).toBeGreaterThan(0n);

    await listing.transition({
      instrumentId,
      targetStatus: 'ACTIVE',
      actorId: 'listing-operator-a',
      reason: 'Secondary trading and redemption opened after settlement',
      correlationId: randomUUID(),
    });
    await pool.query(
      `INSERT INTO mock_ezr_receipts (
         receipt_id, owner, commodity, quantity, unit, elevator_id, status, instrument_id
       ) VALUES ($1, $2, 'WHEAT', 100, 'GRAM', 'ELEVATOR-E2E', 'LOCKED', $3)`,
      [assetId, sellerId, instrumentId],
    );
    const redemptions = new RedemptionService(pool, ledger, collateral);
    const redemption = await redemptions.create({
      holderId: buyerId,
      instrumentId,
      quantity: 100n,
      method: 'PHYSICAL_DELIVERY',
      delivery: {
        elevatorId: 'ELEVATOR-E2E',
        requestedDate: '2026-08-20',
        recipient: 'E2E buyer',
        transport: 'E2E truck',
      },
      proofs: [],
      idempotencyKey: `e2e-redemption-${randomUUID()}`,
      correlationId: randomUUID(),
    });
    if ('code' in redemption.body) throw new Error(redemption.body.message);
    await redemptions.prepareDelivery(redemption.body.id, randomUUID());
    const releaseEventId = randomUUID();
    const releaseCorrelationId = randomUUID();
    await pool.query(
      `INSERT INTO oracle_events (
         source_id, event_id, schema_version, instrument_id, asset_id, event_type,
         quantity, unit, observed_at, effective_at, evidence_hash, nonce, signature,
         status, correlation_id, raw_payload, http_status, response_body, applied_at,
         redemption_id
       ) VALUES (
         'e2e-ezr', $1, '1', $2, $3, 'GOODS_RELEASED', 100, 'GRAM', now(), now(),
         'sha256:e2e-release', 2, '{}'::jsonb, 'APPLIED', $4, '{}'::jsonb, 202,
         '{}'::jsonb, now(), $5
       )`,
      [releaseEventId, instrumentId, assetId, releaseCorrelationId, redemption.body.id],
    );
    const completed = await redemptions.applyGoodsReleased({
      eventId: releaseEventId,
      instrumentId,
      assetId,
      eventType: 'GOODS_RELEASED',
      quantity: '100',
      redemptionId: redemption.body.id,
      correlationId: releaseCorrelationId,
    });
    expect(completed.status).toBe('COMPLETED');
    expect(await ledger.balanceOf(buyerTokens)).toBe(0n);
    expect(await ledger.balanceOf(buyerReservedTokens)).toBe(0n);
    const redeemed = await pool.query<{ supply: string; collateral: string }>(
      `SELECT instrument.circulating_supply::text AS supply,
              position.reserved::text AS collateral
       FROM instrument
       JOIN collateral_position AS position ON position.instrument_id = instrument.id
       WHERE instrument.id = $1`,
      [instrumentId],
    );
    expect(redeemed.rows[0]).toEqual({ supply: '0', collateral: '0' });
    expect((await reconcileSupply(pool)).consistent).toBe(true);
    expect((await ledger.trialBalance()).balanced).toBe(true);
  });

  async function insertParties(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await pool.query('INSERT INTO party (id, external_id) VALUES ($1, $2)', [id, `e2e-${id}`]);
    }
  }

  async function instrumentStatus(instrumentId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      'SELECT status::text FROM instrument WHERE id = $1',
      [instrumentId],
    );
    return result.rows[0]?.status ?? '';
  }

  async function openCash(
    ownerId: string,
    purpose: 'AVAILABLE' | 'RESERVED' | 'FEE' | 'RESIDUAL',
    normalSide: 'DEBIT' | 'CREDIT' = 'DEBIT',
  ): Promise<LedgerAccountId> {
    return (
      await ledger.openAccount({
        ownerId,
        accountType: 'CASH',
        currency: 'KZT',
        purpose,
        normalSide,
      })
    ).id;
  }

  async function openToken(
    ownerId: string,
    instrumentId: string,
    purpose: 'AVAILABLE' | 'RESERVED' | 'RESIDUAL',
    normalSide: 'DEBIT' | 'CREDIT' = 'DEBIT',
  ): Promise<LedgerAccountId> {
    return (
      await ledger.openAccount({
        ownerId,
        accountType: 'TOKEN',
        instrumentId,
        purpose,
        normalSide,
      })
    ).id;
  }
});

function draftCommand(): CreateInstrumentDraftCommand {
  return {
    type: 'GRAIN_TOKEN',
    legalNature: 'CLAIM_RIGHT',
    currency: 'KZT',
    unit: 'GRAM',
    unitPerToken: 1n,
    supplyCap: 100n,
    passport: completePassport(),
    actorId: 'grain-issuer',
    correlationId: randomUUID(),
  };
}

function completePassport(): PassportDraft {
  return {
    underlyingAsset: {
      assetClass: 'GRAIN',
      commodity: 'Wheat',
      grade: 'Class 3',
      originCountry: 'KZ',
      unit: 'GRAM',
      storageLocation: 'Elevator E2E',
    },
    holderRights: {
      legalTitle: 'CLAIM_RIGHT',
      claimDescription: 'Claim secured by an electronic grain receipt',
      governingLaw: 'AIFC law',
      redemptionMethods: ['PHYSICAL_DELIVERY'],
      transferRestrictions: [],
    },
    custodyAndVerification: {
      custodianId: 'custodian-e2e',
      registryId: 'ezr-registry-e2e',
      verifierIds: ['e2e-ezr'],
    },
    economics: {
      issuePrice: 100n,
      issueCurrency: 'KZT',
      maturityDate: '2027-08-14',
      feeSchedule: [{ feeType: 'TRADING', amount: 1n, currency: 'KZT' }],
    },
    tradingParameters: {
      tickSize: 10n,
      lotSize: 10n,
      minimumOrderQuantity: 10n,
      minimumDeliveryQuantity: 10n,
      settlementCycle: 'T_PLUS_0',
    },
  };
}

function order(
  participantId: string,
  instrumentId: string,
  side: 'BUY' | 'SELL',
  clientOrderId: string,
): PlaceOrderCommand {
  return {
    participantId,
    clientOrderId,
    instrumentId,
    side,
    type: 'LIMIT',
    price: 100n,
    quantity: 100n,
    idempotencyKey: `e2e-${clientOrderId}-${randomUUID()}`,
    correlationId: randomUUID(),
  };
}

function orderResult(result: {
  readonly body: OrderView | { readonly code: string; readonly message: string };
}): OrderView {
  if ('code' in result.body) throw new Error(`${result.body.code}: ${result.body.message}`);
  return result.body;
}

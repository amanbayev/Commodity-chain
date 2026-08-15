import { randomUUID } from 'node:crypto';

import { PostgresLedger, type LedgerAccountId } from '@commodity-chain/ledger';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcileSettlements } from '../../../../ops/reconcile-settlements.js';
import { InstrumentCommandQueue } from '../oms/instrument-command-queue.js';
import { OmsService } from '../oms/oms.service.js';
import type { OrderView, PlaceOrderCommand } from '../oms/oms.types.js';
import { SettlementCreatedConsumer } from './settlement-created.consumer.js';
import { SettlementService } from './settlement.service.js';
import type { SettlementCreatedDomainEvent } from './settlement.types.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('settlement gross DvP', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
  const ledger = new PostgresLedger(pool);
  let fixture: Fixture;

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
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
        ledger_entries,
        ledger_postings,
        ledger_accounts,
        outbox,
        event_log,
        instrument_passport_versions,
        instrument,
        party
      RESTART IDENTITY CASCADE
    `);
    fixture = await createFixture();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('settles both denominations atomically and reconciles the trade', async () => {
    const { event, settlementId } = await createTrade();
    const before = await systemTotals();
    const consumer = new SettlementCreatedConsumer(new SettlementService(pool, ledger));
    const result = await consumer.handle(event);
    expect(result).toMatchObject({ settlementId, status: 'LEGALLY_FINAL', replayed: false });
    expect(await balances()).toEqual({
      clearingCash: 0n,
      clearingToken: 0n,
      sellerCash: 4_997n,
      buyerToken: 50n,
      fee: 7n,
      residual: 1n,
    });
    expect(await systemTotals()).toEqual(before);
    const posting = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_postings
       WHERE metadata ->> 'operation' = 'SETTLEMENT_GROSS_DVP'`,
    );
    expect(posting.rows[0]?.count).toBe('1');

    const report = await reconcileSettlements(pool, new Date('2026-08-14T12:00:00.000Z'));
    expect(report.consistent).toBe(true);
    expect(report.settlements).toEqual([
      { tradeId: settlementId, status: 'LEGALLY_FINAL', consistent: true, violations: [] },
    ]);
    expect(await status(settlementId)).toBe('RECONCILED');
  });

  it('rolls back every ledger leg when a failure is injected after posting', async () => {
    const { event, settlementId } = await createTrade();
    const before = await balances();
    const failingLedger = new PostgresLedger(pool, {
      afterEntryInserted: (legIndex) => {
        if (legIndex === 1) throw new Error('injected between ledger legs');
      },
    });
    const service = new SettlementService(pool, failingLedger);
    const result = await service.handleCreatedEvent(event);
    expect(result).toMatchObject({
      settlementId,
      status: 'FAILED_BEFORE_FINALITY',
      failureCode: 'DVP_FAILED',
    });
    expect(await balances()).toEqual(before);
    const effects = await pool.query<{ postings: string; incidents: string }>(
      `SELECT
         (SELECT count(*) FROM ledger_postings
          WHERE metadata ->> 'operation' = 'SETTLEMENT_GROSS_DVP')::text AS postings,
         (SELECT count(*) FROM event_log
          WHERE event_type = 'INCIDENT' AND aggregate_id = $1)::text AS incidents`,
      [settlementId],
    );
    expect(effects.rows[0]).toEqual({ postings: '0', incidents: '1' });
  });

  it('processes one hundred duplicate events as one immutable posting', async () => {
    const { event, settlementId } = await createTrade();
    const consumer = new SettlementCreatedConsumer(new SettlementService(pool, ledger));
    const first = await consumer.handle(event);
    for (let replay = 0; replay < 100; replay += 1) {
      await expect(consumer.handle(event)).resolves.toMatchObject({
        settlementId,
        status: 'LEGALLY_FINAL',
        ledgerPostingId: first.ledgerPostingId,
        replayed: true,
      });
    }
    const counts = await pool.query<{ postings: string; transitions: string }>(
      `SELECT
         (SELECT count(*) FROM ledger_postings
          WHERE metadata ->> 'operation' = 'SETTLEMENT_GROSS_DVP')::text AS postings,
         (SELECT count(*) FROM settlement_transitions WHERE settlement_id = $1)::text AS transitions`,
      [settlementId],
    );
    expect(counts.rows[0]).toEqual({ postings: '1', transitions: '4' });
  });

  it('rejects a direct backward status update after legal finality in PostgreSQL', async () => {
    const { event, settlementId } = await createTrade();
    await new SettlementService(pool, ledger).handleCreatedEvent(event);
    await expect(
      pool.query("UPDATE settlements SET finality_status = 'FUNDED' WHERE trade_id = $1", [
        settlementId,
      ]),
    ).rejects.toThrow(/INVALID_SETTLEMENT_TRANSITION|cannot move backward/u);
    expect(await status(settlementId)).toBe('LEGALLY_FINAL');
  });

  it('detects corrupted settlement accounting and records an incident', async () => {
    const { event, settlementId } = await createTrade();
    await new SettlementService(pool, ledger).handleCreatedEvent(event);
    await pool.query('UPDATE settlements SET cash_amount = cash_amount - 1 WHERE trade_id = $1', [
      settlementId,
    ]);
    const report = await reconcileSettlements(pool, new Date('2026-08-14T12:00:00.000Z'));
    expect(report.consistent).toBe(false);
    expect(report.settlements[0]?.violations).toContain('GROSS_NOTIONAL_MISMATCH');
    expect(await status(settlementId)).toBe('PENDING_RECONCILIATION');
    const incidents = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_log
       WHERE event_type = 'INCIDENT' AND aggregate_id = $1`,
      [settlementId],
    );
    expect(incidents.rows[0]?.count).toBe('1');
  });

  async function createFixture(): Promise<Fixture> {
    const instrumentId = randomUUID();
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const clearingId = randomUUID();
    const fundingId = randomUUID();
    const exchangeId = randomUUID();
    await pool.query(
      `INSERT INTO party (id, external_id) VALUES
       ($1, $6), ($2, $7), ($3, $8), ($4, $9), ($5, $10)`,
      [
        buyerId,
        sellerId,
        clearingId,
        fundingId,
        exchangeId,
        `buyer-${buyerId}`,
        `seller-${sellerId}`,
        `clearing-${clearingId}`,
        `funding-${fundingId}`,
        `exchange-${exchangeId}`,
      ],
    );
    const hash = `sha256:${'1'.repeat(64)}`;
    await pool.query(
      `INSERT INTO instrument (
         id, type, legal_nature, status, currency, unit, unit_per_token,
         supply_cap, version, passport_hash
       ) VALUES ($1, 'GRAIN_TOKEN', 'CLAIM_RIGHT', 'ACTIVE', 'KZT', 'GRAM', 1, 1000000, 1, $2)`,
      [instrumentId, hash],
    );
    await pool.query(
      `INSERT INTO instrument_passport_versions (
         instrument_id, version, passport, review_state, passport_hash,
         submitted_at, published_at, created_by
       ) VALUES ($1, 1, $2::jsonb, 'APPROVED', $3, now(), now(), 'settlement-test')`,
      [
        instrumentId,
        JSON.stringify({
          tradingParameters: {
            tickSize: '10',
            lotSize: '10',
            minimumOrderQuantity: '10',
            minimumDeliveryQuantity: '10',
            settlementCycle: 'T_PLUS_0',
          },
        }),
        hash,
      ],
    );
    await pool.query(
      `INSERT INTO fee_schedules (
         instrument_id, version, currency, maker_rate_ppm, taker_rate_ppm, effective_from
       ) VALUES ($1, 1, 'KZT', 500, 1000, now() - interval '1 day')`,
      [instrumentId],
    );

    const buyerCashAvailable = await openCash(buyerId, 'AVAILABLE');
    await openCash(buyerId, 'RESERVED');
    const buyerTokenAvailable = await openToken(buyerId, instrumentId, 'AVAILABLE');
    const sellerCashAvailable = await openCash(sellerId, 'AVAILABLE');
    const sellerTokenAvailable = await openToken(sellerId, instrumentId, 'AVAILABLE');
    await openToken(sellerId, instrumentId, 'RESERVED');
    const clearingCash = await openCash(clearingId, 'RESERVED');
    const clearingToken = await openToken(clearingId, instrumentId, 'RESERVED');
    const feeAccount = await openCash(exchangeId, 'FEE');
    const residualAccount = await openCash(exchangeId, 'RESIDUAL');
    const cashIssuance = await openCash(fundingId, 'RESIDUAL', 'CREDIT');
    const tokenIssuance = await openToken(fundingId, instrumentId, 'RESIDUAL', 'CREDIT');
    await ledger.post({
      idempotencyKey: `settlement-test-cash-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: buyerCashAvailable, direction: 'DEBIT', amount: 100_000n },
        { accountId: cashIssuance, direction: 'CREDIT', amount: 100_000n },
      ],
    });
    await ledger.post({
      idempotencyKey: `settlement-test-token-${randomUUID()}`,
      correlationId: randomUUID(),
      legs: [
        { accountId: sellerTokenAvailable, direction: 'DEBIT', amount: 1_000n },
        { accountId: tokenIssuance, direction: 'CREDIT', amount: 1_000n },
      ],
    });
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
    return {
      instrumentId,
      buyerId,
      sellerId,
      clearingCash,
      clearingToken,
      sellerCashAvailable,
      buyerTokenAvailable,
      feeAccount,
      residualAccount,
    };
  }

  async function createTrade(): Promise<{
    event: SettlementCreatedDomainEvent;
    settlementId: string;
  }> {
    const oms = new OmsService(pool, ledger, new InstrumentCommandQueue());
    await oms.place(order(fixture.sellerId, 'SELL', 'seller'));
    const buy = orderResult(await oms.place(order(fixture.buyerId, 'BUY', 'buyer')));
    const settlementId = buy.trades[0]?.tradeId;
    if (settlementId === undefined) throw new Error('Expected one trade');
    const outbox = await pool.query<{ payload: SettlementCreatedDomainEvent }>(
      `SELECT payload FROM outbox
       WHERE topic = 'domain.settlement.created.v1'
         AND payload ->> 'tradeId' = $1`,
      [settlementId],
    );
    const event = outbox.rows[0]?.payload;
    if (event === undefined) throw new Error('Settlement outbox event was not emitted');
    return { event, settlementId };
  }

  function order(
    participantId: string,
    side: 'BUY' | 'SELL',
    clientOrderId: string,
  ): PlaceOrderCommand {
    return {
      participantId,
      clientOrderId,
      instrumentId: fixture.instrumentId,
      side,
      type: 'LIMIT',
      price: 100n,
      quantity: 50n,
      idempotencyKey: `settlement-${clientOrderId}-${randomUUID()}`,
      correlationId: randomUUID(),
    };
  }

  async function balances() {
    return {
      clearingCash: await ledger.balanceOf(fixture.clearingCash),
      clearingToken: await ledger.balanceOf(fixture.clearingToken),
      sellerCash: await ledger.balanceOf(fixture.sellerCashAvailable),
      buyerToken: await ledger.balanceOf(fixture.buyerTokenAvailable),
      fee: await ledger.balanceOf(fixture.feeAccount),
      residual: await ledger.balanceOf(fixture.residualAccount),
    };
  }

  async function systemTotals(): Promise<{ cash: string; token: string }> {
    const result = await pool.query<{ cash: string; token: string }>(`
      SELECT
        coalesce(sum(balance) FILTER (
          WHERE account_type = 'CASH' AND normal_side = 'DEBIT'
        ), 0)::text AS cash,
        coalesce(sum(balance) FILTER (
          WHERE account_type = 'TOKEN' AND normal_side = 'DEBIT'
        ), 0)::text AS token
      FROM ledger_accounts
    `);
    return result.rows[0] ?? { cash: '0', token: '0' };
  }

  async function status(settlementId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      'SELECT finality_status::text AS status FROM settlements WHERE trade_id = $1',
      [settlementId],
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

interface Fixture {
  readonly instrumentId: string;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly clearingCash: LedgerAccountId;
  readonly clearingToken: LedgerAccountId;
  readonly sellerCashAvailable: LedgerAccountId;
  readonly buyerTokenAvailable: LedgerAccountId;
  readonly feeAccount: LedgerAccountId;
  readonly residualAccount: LedgerAccountId;
}

function orderResult(result: {
  readonly body: OrderView | { readonly code: string; readonly message: string };
}): OrderView {
  if ('code' in result.body) throw new Error(`${result.body.code}: ${result.body.message}`);
  return result.body;
}

import { randomUUID } from 'node:crypto';

import { PostgresLedger } from '@commodity-chain/ledger';
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcileSupply } from '../../../../ops/reconcile-supply.js';
import { MintService } from '../instrument/mint.service.js';
import type {
  MintCollateralProof,
  MintCommand,
  MintExecutionResult,
} from '../instrument/mint.types.js';
import { AppliedOracleEventConsumer } from './applied-oracle-event.consumer.js';
import { PostgresCollateralLedger } from './collateral-ledger.service.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('collateral and mint invariants', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 30 });
  const collateral = new PostgresCollateralLedger(pool);
  const consumer = new AppliedOracleEventConsumer(collateral);
  const ledger = new PostgresLedger(pool);
  let oracleNonce = 0n;

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies APPLIED RECEIPT_LOCKED once with provenance and rejects other oracle states', async () => {
    const fixture = await createFixture({ assetQuantity: 100n });
    const eventId = await createOracleEvent(fixture, 'RECEIPT_LOCKED', 70n, 'APPLIED');

    await consumer.handle(oracleMessage(fixture, eventId, 'RECEIPT_LOCKED', 70n));
    await consumer.handle(oracleMessage(fixture, eventId, 'RECEIPT_LOCKED', 70n));

    expect(await collateral.verifiedAvailable(fixture.instrumentId)).toBe(70n);
    const provenance = await pool.query<{ movements: string; audits: string }>(
      `
        SELECT
          (SELECT count(*) FROM collateral_position_movements
            WHERE oracle_event_id = $1)::text AS movements,
          (SELECT count(*) FROM event_log
            WHERE event_type = 'COLLATERAL_RESERVED')::text AS audits
      `,
      [eventId],
    );
    expect(provenance.rows[0]).toEqual({ movements: '1', audits: '1' });

    const rejectedEvent = await createOracleEvent(fixture, 'RECEIPT_LOCKED', 10n, 'REJECTED');
    await expect(
      consumer.handle(oracleMessage(fixture, rejectedEvent, 'RECEIPT_LOCKED', 10n)),
    ).rejects.toMatchObject({ code: 'ORACLE_EVENT_NOT_APPLIED' });
  });

  it('prevents two instruments from over-reserving one asset under race', async () => {
    const first = await createFixture({ assetQuantity: 100n });
    const secondInstrumentId = await createInstrument({ status: 'COLLATERALIZED' });
    const second = { ...first, instrumentId: secondInstrumentId };
    const firstEvent = await createOracleEvent(first, 'RECEIPT_LOCKED', 60n, 'APPLIED');
    const secondEvent = await createOracleEvent(second, 'RECEIPT_LOCKED', 60n, 'APPLIED');

    const results = await Promise.allSettled([
      collateral.reserve(first.assetId, first.instrumentId, 60n, firstEvent),
      collateral.reserve(second.assetId, second.instrumentId, 60n, secondEvent),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'ASSET_COLLATERAL_EXCEEDED' } });
    const total = await pool.query<{ reserved: string }>(
      'SELECT coalesce(sum(reserved), 0)::text AS reserved FROM collateral_position WHERE asset_id = $1',
      [first.assetId],
    );
    expect(total.rows[0]?.reserved).toBe('60');
  });

  it('does not release below zero or collateral already supporting supply', async () => {
    const fixture = await createFixture({ assetQuantity: 100n, unitPerToken: 10n });
    await applyReserve(fixture, 80n);

    const excessiveRelease = await createOracleEvent(fixture, 'GOODS_RELEASED', 90n, 'APPLIED');
    await expect(
      collateral.release(fixture.assetId, fixture.instrumentId, 90n, excessiveRelease),
    ).rejects.toMatchObject({ code: 'COLLATERAL_RELEASE_EXCEEDS_RESERVED' });

    await pool.query('UPDATE instrument SET circulating_supply = 5 WHERE id = $1', [
      fixture.instrumentId,
    ]);
    const supportRelease = await createOracleEvent(fixture, 'GOODS_RELEASED', 40n, 'APPLIED');
    await expect(
      collateral.release(fixture.assetId, fixture.instrumentId, 40n, supportRelease),
    ).rejects.toMatchObject({ code: 'COLLATERAL_SUPPORT_IN_USE' });
    expect(await collateral.verifiedAvailable(fixture.instrumentId)).toBe(80n);
  });

  it.each([
    ['INVALID_STATUS', { status: 'DRAFT' as const }],
    ['SUPPLY_EXCEEDS_COLLATERAL', { reserveQuantity: 20n, mintQuantity: 30n }],
    ['SUPPLY_CAP_EXCEEDED', { supplyCap: 20n, mintQuantity: 30n }],
    ['MINT_ACCOUNT_NOT_CONFIGURED', { configureAccounts: false }],
    ['COLLATERAL_PROOF_INVALID', { invalidProof: true }],
  ])('returns deterministic mint failure %s without supply changes', async (code, options) => {
    const setup = await setupMint(options);
    const service = new MintService(pool, collateral);
    const result = await service.execute(setup.command);

    expect(errorCode(result)).toBe(code);
    expect(await databaseSupply(setup.fixture.instrumentId)).toBe(0n);
    expect(await postingCount()).toBe(0n);
  });

  it('returns RESOURCE_NOT_FOUND and rejects Idempotency-Key payload reuse', async () => {
    const service = new MintService(pool, collateral);
    const missing = await service.execute(
      mintCommand(
        {
          instrumentId: randomUUID(),
          assetId: 'missing-asset',
          ownerId: randomUUID(),
        },
        1n,
      ),
    );
    expect(errorCode(missing)).toBe('RESOURCE_NOT_FOUND');

    await resetDatabase();
    const setup = await setupMint({});
    const first = await service.execute(setup.command);
    expect(first.httpStatus).toBe(201);
    const conflict = await service.execute({ ...setup.command, quantity: 2n });
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await databaseSupply(setup.fixture.instrumentId)).toBe(1n);
  });

  it('serializes competing mint commands so exactly one can consume remaining collateral', async () => {
    const setup = await setupMint({ reserveQuantity: 100n, mintQuantity: 60n });
    const service = new MintService(pool, collateral);
    const results = await Promise.all([
      service.execute(setup.command),
      service.execute({
        ...setup.command,
        idempotencyKey: `mint-${randomUUID()}`,
        correlationId: randomUUID(),
      }),
    ]);

    expect(results.filter((result) => result.httpStatus === 201)).toHaveLength(1);
    expect(
      results.filter((result) => errorCode(result) === 'SUPPLY_EXCEEDS_COLLATERAL'),
    ).toHaveLength(1);
    expect(await databaseSupply(setup.fixture.instrumentId)).toBe(60n);
    expect(await distributionBalance(setup.fixture.instrumentId)).toBe(60n);
    expect(await postingCount()).toBe(1n);
  });

  it('replays 100 mint commands as one issuance', async () => {
    const setup = await setupMint({ reserveQuantity: 100n, mintQuantity: 10n });
    const service = new MintService(pool, collateral);

    const first = await service.execute(setup.command);
    expect(first.httpStatus).toBe(201);
    for (let replay = 0; replay < 100; replay += 1) {
      const result = await service.execute(setup.command);
      expect(result.httpStatus).toBe(201);
      expect(result.replayed).toBe(true);
    }

    expect(await databaseSupply(setup.fixture.instrumentId)).toBe(10n);
    expect(await distributionBalance(setup.fixture.instrumentId)).toBe(10n);
    expect(await postingCount()).toBe(1n);
    const effects = await pool.query<{ audits: string; messages: string }>(`
      SELECT
        (SELECT count(*) FROM event_log WHERE event_type = 'TOKENS_MINTED')::text AS audits,
        (SELECT count(*) FROM outbox WHERE topic = 'domain.instrument.minted.v1')::text AS messages
    `);
    expect(effects.rows[0]).toEqual({ audits: '1', messages: '1' });
  });

  it('rolls back the ledger posting when a later mint step fails', async () => {
    const setup = await setupMint({ reserveQuantity: 100n, mintQuantity: 10n });
    const invalidClock = (): Date => new Date(Number.NaN);
    const service = new MintService(pool, collateral, invalidClock);

    await expect(service.execute(setup.command)).rejects.toThrow(RangeError);

    expect(await databaseSupply(setup.fixture.instrumentId)).toBe(0n);
    expect(await distributionBalance(setup.fixture.instrumentId)).toBe(0n);
    expect(await postingCount()).toBe(0n);
    const effects = await pool.query<{ audits: string; messages: string }>(`
      SELECT
        (SELECT count(*) FROM event_log WHERE event_type = 'TOKENS_MINTED')::text AS audits,
        (SELECT count(*) FROM outbox WHERE topic = 'domain.instrument.minted.v1')::text AS messages
    `);
    expect(effects.rows[0]).toEqual({ audits: '0', messages: '0' });
  });

  it('keeps collateralization and reconciliation valid for random operation sequences', async () => {
    const operation = fc.record({
      kind: fc.constantFrom<'RESERVE' | 'MINT' | 'RELEASE'>('RESERVE', 'MINT', 'RELEASE'),
      amount: fc.bigInt({ min: 1n, max: 100n }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (operations) => {
        await resetDatabase();
        const setup = await setupMint({
          reserveQuantity: 0n,
          mintQuantity: 1n,
          assetQuantity: 500n,
          unitPerToken: 2n,
        });
        const service = new MintService(pool, collateral);

        for (const [index, current] of operations.entries()) {
          if (current.kind === 'RESERVE') {
            const eventId = await createOracleEvent(
              setup.fixture,
              'RECEIPT_LOCKED',
              current.amount,
              'APPLIED',
            );
            await collateral
              .reserve(setup.fixture.assetId, setup.fixture.instrumentId, current.amount, eventId)
              .catch(() => undefined);
          } else if (current.kind === 'RELEASE') {
            const eventId = await createOracleEvent(
              setup.fixture,
              'GOODS_RELEASED',
              current.amount,
              'APPLIED',
            );
            await collateral
              .release(setup.fixture.assetId, setup.fixture.instrumentId, current.amount, eventId)
              .catch(() => undefined);
          } else {
            const reserved = await collateral.verifiedAvailable(setup.fixture.instrumentId);
            await service.execute({
              ...setup.command,
              quantity: current.amount,
              idempotencyKey: `property-${index}-${randomUUID()}`,
              correlationId: randomUUID(),
              collateralProof: {
                ...setup.command.collateralProof,
                reserved: (reserved > 0n ? reserved : 1n).toString(),
              },
            });
          }

          const supply = await databaseSupply(setup.fixture.instrumentId);
          const verified = await collateral.verifiedAvailable(setup.fixture.instrumentId);
          expect(supply * 2n).toBeLessThanOrEqual(verified);
        }

        const report = await reconcileSupply(pool);
        expect(report.consistent).toBe(true);
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  it('reports reconciliation mismatches and appends an INCIDENT', async () => {
    const setup = await setupMint({ reserveQuantity: 100n, mintQuantity: 10n });
    const service = new MintService(pool, collateral);
    await service.execute(setup.command);
    await pool.query('UPDATE instrument SET circulating_supply = 11 WHERE id = $1', [
      setup.fixture.instrumentId,
    ]);

    const report = await reconcileSupply(pool, new Date('2026-08-14T12:00:00.000Z'));
    expect(report.consistent).toBe(false);
    expect(report.instruments[0]?.violations).toContain('DATABASE_LEDGER_SUPPLY_MISMATCH');
    const incident = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_log WHERE event_type = 'INCIDENT'`,
    );
    expect(incident.rows[0]?.count).toBe('1');
  });

  interface Fixture {
    readonly ownerId: string;
    readonly instrumentId: string;
    readonly assetId: string;
  }

  async function resetDatabase(): Promise<void> {
    oracleNonce = 0n;
    await pool.query(`
      TRUNCATE
        mint_commands,
        instrument_token_accounts,
        collateral_position_movements,
        collateral_position,
        oracle_events,
        outbox,
        event_log,
        ledger_entries,
        ledger_postings,
        ledger_accounts,
        asset,
        instrument,
        wallet_account,
        party
      RESTART IDENTITY CASCADE
    `);
  }

  async function createFixture(
    options: {
      readonly assetQuantity?: bigint;
      readonly unitPerToken?: bigint;
      readonly supplyCap?: bigint;
      readonly status?: string;
    } = {},
  ): Promise<Fixture> {
    const ownerId = randomUUID();
    await pool.query(`INSERT INTO party (id, external_id) VALUES ($1, $2)`, [
      ownerId,
      `party-${ownerId}`,
    ]);
    const instrumentId = await createInstrument(options);
    const assetId = `asset-${randomUUID()}`;
    await pool.query(
      `
        INSERT INTO asset (
          asset_id, class, owner_party_id, quantity, unit, location, encumbrance_status
        )
        VALUES ($1, 'GRAIN', $2, $3, 'GRAM', 'TEST_ELEVATOR', 'FREE')
      `,
      [assetId, ownerId, (options.assetQuantity ?? 1_000n).toString()],
    );
    return { ownerId, instrumentId, assetId };
  }

  async function createInstrument(
    options: {
      readonly unitPerToken?: bigint;
      readonly supplyCap?: bigint;
      readonly status?: string;
    } = {},
  ): Promise<string> {
    const instrumentId = randomUUID();
    await pool.query(
      `
        INSERT INTO instrument (
          id, type, legal_nature, status, currency, unit, unit_per_token, supply_cap
        )
        VALUES ($1, 'GRAIN_TOKEN', 'CLAIM_RIGHT', $2, 'KZT', 'GRAM', $3, $4)
      `,
      [
        instrumentId,
        options.status ?? 'COLLATERALIZED',
        (options.unitPerToken ?? 1n).toString(),
        (options.supplyCap ?? 10_000n).toString(),
      ],
    );
    return instrumentId;
  }

  async function createOracleEvent(
    fixture: Fixture,
    eventType: 'RECEIPT_LOCKED' | 'GOODS_RELEASED',
    quantity: bigint,
    status: 'APPLIED' | 'REJECTED',
  ): Promise<string> {
    oracleNonce += 1n;
    const eventId = randomUUID();
    const correlationId = randomUUID();
    const appliedAt = status === 'APPLIED' ? new Date() : null;
    await pool.query(
      `
        INSERT INTO oracle_events (
          source_id,
          event_id,
          schema_version,
          instrument_id,
          asset_id,
          event_type,
          quantity,
          unit,
          observed_at,
          effective_at,
          evidence_hash,
          nonce,
          signature,
          status,
          correlation_id,
          raw_payload,
          http_status,
          response_body,
          applied_at
        )
        VALUES (
          'collateral-test-source', $1, '1', $2, $3, $4, $5, 'GRAM', now(), now(),
          'sha256:0123456789abcdef', $6, '{}'::jsonb, $7, $8, '{}'::jsonb, 202,
          '{}'::jsonb, $9
        )
      `,
      [
        eventId,
        fixture.instrumentId,
        fixture.assetId,
        eventType,
        quantity.toString(),
        oracleNonce.toString(),
        status,
        correlationId,
        appliedAt,
      ],
    );
    return eventId;
  }

  async function applyReserve(fixture: Fixture, quantity: bigint): Promise<void> {
    const eventId = await createOracleEvent(fixture, 'RECEIPT_LOCKED', quantity, 'APPLIED');
    await consumer.handle(oracleMessage(fixture, eventId, 'RECEIPT_LOCKED', quantity));
  }

  function oracleMessage(fixture: Fixture, eventId: string, eventType: string, quantity: bigint) {
    return {
      eventId,
      instrumentId: fixture.instrumentId,
      assetId: fixture.assetId,
      eventType,
      quantity: quantity.toString(),
    };
  }

  async function setupMint(options: {
    readonly status?: 'DRAFT' | 'COLLATERALIZED' | 'ACTIVE';
    readonly assetQuantity?: bigint;
    readonly reserveQuantity?: bigint;
    readonly mintQuantity?: bigint;
    readonly unitPerToken?: bigint;
    readonly supplyCap?: bigint;
    readonly configureAccounts?: boolean;
    readonly invalidProof?: boolean;
  }): Promise<{ readonly fixture: Fixture; readonly command: MintCommand }> {
    const fixture = await createFixture({
      assetQuantity: options.assetQuantity ?? 1_000n,
      unitPerToken: options.unitPerToken ?? 1n,
      supplyCap: options.supplyCap ?? 10_000n,
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    const reserveQuantity = options.reserveQuantity ?? 100n;
    if (reserveQuantity > 0n) {
      await applyReserve(fixture, reserveQuantity);
    }
    if (options.configureAccounts !== false) {
      await configureMintAccounts(fixture);
    }
    const command = mintCommand(fixture, options.mintQuantity ?? 1n);
    return {
      fixture,
      command: options.invalidProof
        ? {
            ...command,
            collateralProof: {
              ...command.collateralProof,
              evidenceHash: 'sha256:fedcba9876543210',
            },
          }
        : command,
    };
  }

  async function configureMintAccounts(fixture: Fixture): Promise<void> {
    const distribution = await ledger.openAccount({
      ownerId: fixture.ownerId,
      accountType: 'TOKEN',
      instrumentId: fixture.instrumentId,
      purpose: 'AVAILABLE',
      normalSide: 'CREDIT',
    });
    const issuance = await ledger.openAccount({
      ownerId: fixture.ownerId,
      accountType: 'TOKEN',
      instrumentId: fixture.instrumentId,
      purpose: 'RESIDUAL',
      normalSide: 'DEBIT',
    });
    await pool.query(
      `
        INSERT INTO instrument_token_accounts (
          instrument_id, distribution_account_id, issuance_account_id
        )
        VALUES ($1, $2, $3)
      `,
      [fixture.instrumentId, distribution.id, issuance.id],
    );
  }

  function mintCommand(fixture: Fixture, quantity: bigint): MintCommand {
    const proof: MintCollateralProof = {
      assetId: fixture.assetId,
      instrumentId: fixture.instrumentId,
      reserved: '1',
      unit: 'GRAM',
      evidenceHash: 'sha256:0123456789abcdef',
      verifierProofs: [{ verifierId: 'oracle-test' }],
    };
    return {
      instrumentId: fixture.instrumentId,
      quantity,
      unit: 'GRAM',
      collateralProof: proof,
      idempotencyKey: `mint-${randomUUID()}`,
      correlationId: randomUUID(),
    };
  }

  async function databaseSupply(instrumentId: string): Promise<bigint> {
    const result = await pool.query<{ supply: string }>(
      'SELECT circulating_supply::text AS supply FROM instrument WHERE id = $1',
      [instrumentId],
    );
    return BigInt(result.rows[0]?.supply ?? '0');
  }

  async function distributionBalance(instrumentId: string): Promise<bigint> {
    const result = await pool.query<{ balance: string }>(
      `
        SELECT account.balance::text
        FROM instrument_token_accounts AS mapping
        JOIN ledger_accounts AS account ON account.id = mapping.distribution_account_id
        WHERE mapping.instrument_id = $1
      `,
      [instrumentId],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  async function postingCount(): Promise<bigint> {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_postings',
    );
    return BigInt(result.rows[0]?.count ?? '0');
  }

  function errorCode(result: MintExecutionResult): string | undefined {
    return 'code' in result.body ? result.body.code : undefined;
  }
});

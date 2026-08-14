import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface ReconciliationClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface InstrumentSupplyRow {
  instrument_id: string;
  database_supply: string;
  ledger_supply: string;
  unit_per_token: string;
  verified_collateral: string;
}

export interface InstrumentSupplyCheck {
  readonly instrumentId: string;
  readonly databaseSupply: string;
  readonly ledgerSupply: string;
  readonly unitPerToken: string;
  readonly verifiedCollateral: string;
  readonly requiredCollateral: string;
  readonly consistent: boolean;
  readonly violations: readonly string[];
}

export interface SupplyReconciliationReport {
  readonly checkedAt: string;
  readonly consistent: boolean;
  readonly instruments: readonly InstrumentSupplyCheck[];
}

export async function reconcileSupply(
  client: ReconciliationClient,
  checkedAt = new Date(),
): Promise<SupplyReconciliationReport> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const result = await client.query<InstrumentSupplyRow>(`
      SELECT
        instrument.id::text AS instrument_id,
        instrument.circulating_supply::text AS database_supply,
        coalesce(
          sum(account.balance) FILTER (
            WHERE account.account_type = 'TOKEN'
              AND account.normal_side = 'CREDIT'
              AND account.purpose <> 'RESIDUAL'
          ),
          0
        )::text AS ledger_supply,
        instrument.unit_per_token::text,
        coalesce(collateral.total, 0)::text AS verified_collateral
      FROM instrument
      LEFT JOIN ledger_accounts AS account ON account.instrument_id = instrument.id
      LEFT JOIN LATERAL (
        SELECT sum(position.reserved) AS total
        FROM collateral_position AS position
        WHERE position.instrument_id = instrument.id
      ) AS collateral ON true
      GROUP BY instrument.id, collateral.total
      ORDER BY instrument.id
    `);

    const instruments = result.rows.map(toCheck);
    for (const instrument of instruments) {
      if (!instrument.consistent) {
        await appendIncident(client, instrument, checkedAt);
      }
    }
    await client.query('COMMIT');
    return {
      checkedAt: checkedAt.toISOString(),
      consistent: instruments.every((instrument) => instrument.consistent),
      instruments,
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function toCheck(row: InstrumentSupplyRow): InstrumentSupplyCheck {
  const databaseSupply = BigInt(row.database_supply);
  const ledgerSupply = BigInt(row.ledger_supply);
  const unitPerToken = BigInt(row.unit_per_token);
  const verifiedCollateral = BigInt(row.verified_collateral);
  const requiredCollateral = databaseSupply * unitPerToken;
  const violations: string[] = [];
  if (databaseSupply !== ledgerSupply) {
    violations.push('DATABASE_LEDGER_SUPPLY_MISMATCH');
  }
  if (requiredCollateral > verifiedCollateral) {
    violations.push('SUPPLY_EXCEEDS_COLLATERAL');
  }
  return {
    instrumentId: row.instrument_id,
    databaseSupply: databaseSupply.toString(),
    ledgerSupply: ledgerSupply.toString(),
    unitPerToken: unitPerToken.toString(),
    verifiedCollateral: verifiedCollateral.toString(),
    requiredCollateral: requiredCollateral.toString(),
    consistent: violations.length === 0,
    violations,
  };
}

async function appendIncident(
  client: ReconciliationClient,
  instrument: InstrumentSupplyCheck,
  checkedAt: Date,
): Promise<void> {
  const nonceResult = await client.query<{ nonce: string }>(
    `SELECT nextval(pg_get_serial_sequence('event_log', 'id'))::text AS nonce`,
  );
  const nonce = nonceResult.rows[0]?.nonce;
  if (nonce === undefined) {
    throw new Error('Could not allocate reconciliation incident nonce');
  }
  const eventId = randomUUID();
  await client.query(
    `
      INSERT INTO event_log (
        id,
        occurred_at,
        actor,
        event_type,
        aggregate_type,
        aggregate_id,
        correlation_id,
        payload
      )
      VALUES ($1, $2, 'ops:reconcile-supply', 'INCIDENT', 'INSTRUMENT', $3, $4, $5::jsonb)
    `,
    [
      nonce,
      checkedAt,
      instrument.instrumentId,
      randomUUID(),
      JSON.stringify({
        eventId,
        nonce,
        eventType: 'INCIDENT',
        schemaVersion: '1',
        occurredAt: checkedAt.toISOString(),
        payload: instrument,
      }),
    ],
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  const requireFromCore = createRequire(new URL('../apps/core/package.json', import.meta.url));
  const { Client } = requireFromCore('pg') as {
    Client: new (options: { connectionString: string }) => ReconciliationClient & {
      connect(): Promise<void>;
      end(): Promise<void>;
    };
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const report = await reconcileSupply(client);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.consistent) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

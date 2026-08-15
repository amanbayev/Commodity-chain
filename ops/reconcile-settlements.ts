import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface SettlementReconciliationClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface CandidateRow {
  trade_id: string;
  price: string;
  trade_quantity: string;
  settlement_id: string | null;
  status: string | null;
  cash_amount: string | null;
  token_quantity: string | null;
  buyer_fee: string | null;
  seller_fee: string | null;
  residual: string | null;
  posting_id: string | null;
  cash_source: string | null;
  token_source: string | null;
  seller_cash: string | null;
  buyer_token: string | null;
  fee_account: string | null;
  residual_account: string | null;
}

interface EntryRow {
  account_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
}

interface FeeAggregateRow {
  fee: string;
  residual: string;
  total: string;
}

export interface SettlementCheck {
  readonly tradeId: string;
  readonly status: string | null;
  readonly consistent: boolean;
  readonly violations: readonly string[];
}

export interface SettlementReconciliationReport {
  readonly checkedAt: string;
  readonly consistent: boolean;
  readonly settlements: readonly SettlementCheck[];
}

export async function reconcileSettlements(
  client: SettlementReconciliationClient,
  checkedAt = new Date(),
): Promise<SettlementReconciliationReport> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const candidates = await client.query<CandidateRow>(`
      SELECT
        trade.trade_id::text,
        trade.price::text,
        trade.quantity::text AS trade_quantity,
        settlement.trade_id::text AS settlement_id,
        settlement.finality_status::text AS status,
        settlement.cash_amount::text,
        settlement.token_quantity::text,
        settlement.buyer_fee_amount::text AS buyer_fee,
        settlement.seller_fee_amount::text AS seller_fee,
        settlement.rounding_residual::text AS residual,
        settlement.ledger_posting_id::text AS posting_id,
        snapshot.cash_source_account_id::text AS cash_source,
        snapshot.token_source_account_id::text AS token_source,
        snapshot.seller_cash_available_account_id::text AS seller_cash,
        snapshot.buyer_token_available_account_id::text AS buyer_token,
        snapshot.fee_account_id::text AS fee_account,
        snapshot.residual_account_id::text AS residual_account
      FROM trades AS trade
      LEFT JOIN settlements AS settlement ON settlement.trade_id = trade.trade_id
      LEFT JOIN settlement_account_snapshots AS snapshot
        ON snapshot.settlement_id = settlement.trade_id
      ORDER BY trade.trade_id
    `);
    const checks: SettlementCheck[] = [];
    for (const candidate of candidates.rows) {
      const check = await checkCandidate(client, candidate);
      checks.push(check);
      if (!check.consistent) {
        await recordIncident(client, check, checkedAt);
        if (candidate.status === 'LEGALLY_FINAL') {
          await transition(client, candidate.trade_id, 'PENDING_RECONCILIATION', checkedAt);
        }
      } else if (candidate.status === 'LEGALLY_FINAL') {
        await transition(client, candidate.trade_id, 'RECONCILED', checkedAt);
      }
    }
    await client.query('COMMIT');
    return {
      checkedAt: checkedAt.toISOString(),
      consistent: checks.every((check) => check.consistent),
      settlements: checks,
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function checkCandidate(
  client: SettlementReconciliationClient,
  row: CandidateRow,
): Promise<SettlementCheck> {
  const violations: string[] = [];
  if (row.settlement_id === null) {
    return {
      tradeId: row.trade_id,
      status: null,
      consistent: false,
      violations: ['SETTLEMENT_MISSING'],
    };
  }
  if (!isFinalStatus(row.status)) {
    return { tradeId: row.trade_id, status: row.status, consistent: true, violations };
  }
  const required = [
    row.cash_amount,
    row.token_quantity,
    row.buyer_fee,
    row.seller_fee,
    row.residual,
    row.posting_id,
    row.cash_source,
    row.token_source,
    row.seller_cash,
    row.buyer_token,
    row.fee_account,
    row.residual_account,
  ];
  if (required.some((value) => value === null)) {
    return {
      tradeId: row.trade_id,
      status: row.status,
      consistent: false,
      violations: ['SETTLEMENT_ACCOUNTING_INCOMPLETE'],
    };
  }
  const gross = BigInt(row.price) * BigInt(row.trade_quantity);
  const cashAmount = BigInt(row.cash_amount!);
  const tokenQuantity = BigInt(row.token_quantity!);
  const buyerFee = BigInt(row.buyer_fee!);
  const sellerFee = BigInt(row.seller_fee!);
  const residual = BigInt(row.residual!);
  if (cashAmount !== gross) violations.push('GROSS_NOTIONAL_MISMATCH');
  if (tokenQuantity !== BigInt(row.trade_quantity)) violations.push('TOKEN_QUANTITY_MISMATCH');
  if (buyerFee + sellerFee < residual) violations.push('FEE_RESIDUAL_MISMATCH');
  const feeRows = await client.query<FeeAggregateRow>(
    `SELECT
       coalesce(sum(amount) FILTER (WHERE component = 'FEE'), 0)::text AS fee,
       coalesce(sum(amount) FILTER (WHERE component = 'RESIDUAL'), 0)::text AS residual,
       coalesce(sum(amount), 0)::text AS total
     FROM settlement_fees WHERE settlement_id = $1`,
    [row.trade_id],
  );
  const recordedFees = feeRows.rows[0];
  if (
    recordedFees === undefined ||
    BigInt(recordedFees.fee) !== buyerFee + sellerFee - residual ||
    BigInt(recordedFees.residual) !== residual ||
    BigInt(recordedFees.total) !== buyerFee + sellerFee
  ) {
    violations.push('FEE_RESIDUAL_MISMATCH');
  }

  const entries = await client.query<EntryRow>(
    `SELECT account_id::text, direction::text, amount::text
     FROM ledger_entries WHERE posting_id = $1 ORDER BY leg_index`,
    [row.posting_id],
  );
  const expected = new Map<string, bigint>([
    [key(row.cash_source!, 'CREDIT'), cashAmount + buyerFee],
    [key(row.seller_cash!, 'DEBIT'), cashAmount - sellerFee],
    [key(row.fee_account!, 'DEBIT'), buyerFee + sellerFee - residual],
    [key(row.residual_account!, 'DEBIT'), residual],
    [key(row.token_source!, 'CREDIT'), tokenQuantity],
    [key(row.buyer_token!, 'DEBIT'), tokenQuantity],
  ]);
  for (const [entryKey, amount] of [...expected]) {
    if (amount === 0n) expected.delete(entryKey);
  }
  const actual = new Map<string, bigint>();
  for (const entry of entries.rows) {
    const entryKey = key(entry.account_id, entry.direction);
    actual.set(entryKey, (actual.get(entryKey) ?? 0n) + BigInt(entry.amount));
  }
  if (!mapsEqual(expected, actual)) violations.push('LEDGER_DVP_MISMATCH');
  return {
    tradeId: row.trade_id,
    status: row.status,
    consistent: violations.length === 0,
    violations,
  };
}

async function transition(
  client: SettlementReconciliationClient,
  settlementId: string,
  target: 'RECONCILED' | 'PENDING_RECONCILIATION',
  occurredAt: Date,
): Promise<void> {
  const current = await client.query<{ status: string }>(
    'SELECT finality_status::text AS status FROM settlements WHERE trade_id = $1 FOR UPDATE',
    [settlementId],
  );
  const from = current.rows[0]?.status;
  if (from !== 'LEGALLY_FINAL') return;
  const nonce = await allocateNonce(client);
  const eventId = randomUUID();
  const correlationId = randomUUID();
  await client.query(
    `UPDATE settlements
     SET finality_status = $2::settlement_finality_status, updated_at = $3,
         reconciled_at = CASE WHEN $2::text = 'RECONCILED' THEN $3 ELSE reconciled_at END
     WHERE trade_id = $1`,
    [settlementId, target, occurredAt],
  );
  await client.query(
    `INSERT INTO settlement_transitions (
       settlement_id, from_status, to_status, actor, reason,
       event_id, nonce, correlation_id, occurred_at
     ) VALUES ($1, 'LEGALLY_FINAL', $2, 'ops:reconcile-settlements', $3, $4, $5, $6, $7)`,
    [
      settlementId,
      target,
      target === 'RECONCILED' ? 'Settlement reconciliation passed' : 'Settlement discrepancy',
      eventId,
      nonce,
      correlationId,
      occurredAt,
    ],
  );
  const payload = {
    eventId,
    nonce,
    eventType: 'SETTLEMENT_STATUS_CHANGED',
    schemaVersion: '1',
    occurredAt: occurredAt.toISOString(),
    payload: {
      settlementId,
      fromStatus: 'LEGALLY_FINAL',
      toStatus: target,
      reason:
        target === 'RECONCILED' ? 'Settlement reconciliation passed' : 'Settlement discrepancy',
    },
  };
  await client.query(
    `INSERT INTO event_log (
       id, occurred_at, actor, event_type, aggregate_type,
       aggregate_id, correlation_id, payload
     ) VALUES ($1, $2, 'ops:reconcile-settlements', 'SETTLEMENT_STATUS_CHANGED',
       'SETTLEMENT', $3, $4, $5::jsonb)`,
    [nonce, occurredAt, settlementId, correlationId, JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO outbox (topic, payload)
     VALUES ('domain.settlement.status-changed.v1', $1::jsonb)`,
    [JSON.stringify(payload)],
  );
}

async function recordIncident(
  client: SettlementReconciliationClient,
  check: SettlementCheck,
  occurredAt: Date,
): Promise<void> {
  const nonce = await allocateNonce(client);
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO event_log (
       id, occurred_at, actor, event_type, aggregate_type,
       aggregate_id, correlation_id, payload
     ) VALUES ($1, $2, 'ops:reconcile-settlements', 'INCIDENT', 'SETTLEMENT', $3, $4, $5::jsonb)`,
    [
      nonce,
      occurredAt,
      check.tradeId,
      randomUUID(),
      JSON.stringify({
        eventId,
        nonce,
        eventType: 'INCIDENT',
        schemaVersion: '1',
        occurredAt: occurredAt.toISOString(),
        payload: check,
      }),
    ],
  );
}

async function allocateNonce(client: SettlementReconciliationClient): Promise<string> {
  const result = await client.query<{ nonce: string }>(
    `SELECT nextval(pg_get_serial_sequence('event_log', 'id'))::text AS nonce`,
  );
  const nonce = result.rows[0]?.nonce;
  if (nonce === undefined) throw new Error('Could not allocate settlement event nonce');
  return nonce;
}

function isFinalStatus(status: string | null): boolean {
  return (
    status === 'LEGALLY_FINAL' ||
    status === 'RECONCILED' ||
    status === 'PENDING_RECONCILIATION' ||
    status === 'MANUAL_REPAIR'
  );
}

function key(accountId: string, direction: string): string {
  return `${accountId}:${direction}`;
}

function mapsEqual(left: ReadonlyMap<string, bigint>, right: ReadonlyMap<string, bigint>): boolean {
  if (left.size !== right.size) return false;
  for (const [entryKey, amount] of left) {
    if (right.get(entryKey) !== amount) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  const requireFromCore = createRequire(new URL('../apps/core/package.json', import.meta.url));
  const { Client } = requireFromCore('pg') as {
    Client: new (options: { connectionString: string }) => SettlementReconciliationClient & {
      connect(): Promise<void>;
      end(): Promise<void>;
    };
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const report = await reconcileSettlements(client);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.consistent) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

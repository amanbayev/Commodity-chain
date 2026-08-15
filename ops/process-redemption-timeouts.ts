import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface RedemptionTimeoutClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface ExpiredRow {
  id: string;
  from_status: 'TOKENS_LOCKED' | 'IN_DELIVERY';
  correlation_id: string;
}

export async function processRedemptionTimeouts(
  client: RedemptionTimeoutClient,
  limit = 100,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('limit must be an integer from 1 to 1000');
  }
  await client.query('BEGIN');
  try {
    const expired = await client.query<ExpiredRow>(
      `WITH candidates AS (
         SELECT id
         FROM redemption_orders
         WHERE status IN ('TOKENS_LOCKED', 'IN_DELIVERY')
           AND delivery_deadline <= now()
         ORDER BY delivery_deadline, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE redemption_orders AS redemption
       SET status = 'EXCEPTION', failure_code = 'DELIVERY_TIMEOUT',
           failure_details = jsonb_build_object('tokensRemainReserved', true),
           exception_at = now(), updated_at = now()
       FROM candidates
       WHERE redemption.id = candidates.id
       RETURNING redemption.id::text, redemption.correlation_id::text,
                 CASE
                   WHEN redemption.delivery_started_at IS NULL THEN 'TOKENS_LOCKED'
                   ELSE 'IN_DELIVERY'
                 END AS from_status`,
      [limit],
    );
    for (const row of expired.rows) {
      await client.query(
        `INSERT INTO redemption_transitions (
           redemption_id, from_status, to_status, actor, reason, correlation_id
         ) VALUES ($1, $2, 'EXCEPTION', 'ops:redemption-timeouts', $3, $4)`,
        [
          row.id,
          row.from_status,
          'No GOODS_RELEASED event received before deadline; tokens remain reserved',
          row.correlation_id,
        ],
      );
      await client.query(
        `INSERT INTO event_log (
           actor, event_type, aggregate_type, aggregate_id, correlation_id, payload
         ) VALUES (
           'ops:redemption-timeouts', 'INCIDENT', 'REDEMPTION', $1, $2, $3::jsonb
         )`,
        [
          row.id,
          row.correlation_id,
          JSON.stringify({
            eventId: randomUUID(),
            redemptionId: row.id,
            code: 'REDEMPTION_DELIVERY_TIMEOUT',
            tokensRemainReserved: true,
          }),
        ],
      );
    }
    await client.query('COMMIT');
    return expired.rows.length;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  const requireFromCore = createRequire(new URL('../apps/core/package.json', import.meta.url));
  const { Client } = requireFromCore('pg') as {
    Client: new (options: { connectionString: string }) => RedemptionTimeoutClient & {
      connect(): Promise<void>;
      end(): Promise<void>;
    };
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const processed = await processRedemptionTimeouts(client);
    process.stdout.write(`${JSON.stringify({ processed })}\n`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  OracleEventEnvelope,
  OracleEventPublisher,
  OracleEventReceipt,
} from '../ezr-registry/types.js';
import { PostgresEzrRegistry } from './postgres-ezr-registry.js';
import { verifyOracleEventSignature } from './signing.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

class RecordingPublisher implements OracleEventPublisher {
  public readonly events: OracleEventEnvelope[] = [];
  public fail = false;

  public publish(envelope: OracleEventEnvelope): Promise<OracleEventReceipt> {
    if (this.fail) {
      return Promise.reject(new Error('gateway unavailable'));
    }
    this.events.push(envelope);
    return Promise.resolve({
      eventId: envelope.eventId,
      acceptedAt: new Date().toISOString(),
      status: 'APPLIED',
      replayed: false,
    });
  }
}

describeWithDatabase('PostgresEzrRegistry', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
  const publisher = new RecordingPublisher();
  const instrumentId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const registry = new PostgresEzrRegistry({
    pool,
    sourceId: 'mock-ezr-registry',
    keyId: 'mock-key-1',
    privateKeyPem: privateKey,
    oraclePublisher: publisher,
    instrumentIdForReceipt: () => instrumentId,
    unitForCommodity: () => 'GRAM',
  });

  beforeEach(async () => {
    publisher.events.length = 0;
    publisher.fail = false;
    await pool.query(
      'TRUNCATE mock_ezr_http_outbox, mock_ezr_receipts, mock_ezr_source_counters CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('issues, locks and releases a bigint receipt with signed monotonic events', async () => {
    const issued = await registry.issueReceipt('owner-1', 'WHEAT', 125_000n, 'elevator-1');
    const locked = await registry.lockReceipt(issued.receiptId, instrumentId);
    const released = await registry.releaseReceipt(issued.receiptId, 'redemption-1');

    expect(issued.quantity).toBe(125_000n);
    expect(locked.status).toBe('LOCKED');
    expect(released.status).toBe('RELEASED');
    expect(publisher.events.map((event) => event.eventType)).toEqual([
      'STOCK_UPDATED',
      'RECEIPT_LOCKED',
      'GOODS_RELEASED',
    ]);
    expect(publisher.events.map((event) => event.nonce)).toEqual([1, 2, 3]);
    expect(publisher.events.every((event) => verifyOracleEventSignature(event, publicKey))).toBe(
      true,
    );
  });

  it('serializes concurrent locks so only one can encumber the receipt', async () => {
    const receipt = await registry.issueReceipt('owner-2', 'WHEAT', 10n, 'elevator-1');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => registry.lockReceipt(receipt.receiptId, instrumentId)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(9);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'ALREADY_ENCUMBERED' });
      }
    }
  });

  it('rejects number quantities at runtime and keeps undelivered events for retry', async () => {
    await expect(
      // @ts-expect-error Quantity is intentionally a number to exercise the runtime guard.
      registry.issueReceipt('owner-3', 'WHEAT', 10, 'elevator-1'),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    publisher.fail = true;
    const receipt = await registry.issueReceipt('owner-3', 'WHEAT', 10n, 'elevator-1');
    const pending = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mock_ezr_http_outbox WHERE delivered_at IS NULL',
    );
    expect(pending.rows[0]?.count).toBe('1');

    publisher.fail = false;
    expect(await registry.drainOutbox()).toBe(1);
    expect(publisher.events[0]?.eventId).toBeDefined();
    expect((await registry.getReceipt(receipt.receiptId))?.quantity).toBe(10n);
  });
});

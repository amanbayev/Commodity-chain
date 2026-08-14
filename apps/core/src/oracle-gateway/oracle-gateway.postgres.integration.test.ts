import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  HttpOracleEventPublisher,
  PostgresEzrRegistry,
  type OracleEventEnvelope,
} from '../../../../packages/adapters/src/index.js';
import { AppModule } from '../app.module.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('EZR mock to oracle gateway', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 20 });
  const sourceId = 'mock-ezr-e2e';
  const keyId = 'mock-ezr-e2e-key';
  const instrumentId = randomUUID();
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  let application: INestApplication;
  let baseUrl: string;
  let publisher: HttpOracleEventPublisher;
  let registry: PostgresEzrRegistry;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = testDatabaseUrl;
    application = await NestFactory.create(AppModule, { logger: false });
    application.setGlobalPrefix('v1');
    await application.listen(0, '127.0.0.1');
    const address = application.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    publisher = new HttpOracleEventPublisher({ baseUrl, bearerToken: 'integration-token' });
    registry = new PostgresEzrRegistry({
      pool,
      sourceId,
      keyId,
      privateKeyPem: keys.privateKey,
      oraclePublisher: publisher,
      instrumentIdForReceipt: () => instrumentId,
      unitForCommodity: () => 'GRAM',
    });
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        mock_ezr_http_outbox,
        mock_ezr_receipts,
        mock_ezr_source_counters,
        oracle_events,
        outbox,
        event_log,
        trusted_sources
      RESTART IDENTITY CASCADE
    `);
    await pool.query(
      `
        INSERT INTO trusted_sources (
          source_id, key_id, algorithm, public_key_pem
        )
        VALUES ($1, $2, 'Ed25519', $3)
      `,
      [sourceId, keyId, keys.publicKey],
    );
  });

  afterAll(async () => {
    await application.close();
    await pool.end();
  });

  it('applies issue and lock events and replays the lock 1000 times with one effect', async () => {
    const receipt = await registry.issueReceipt('owner-e2e', 'WHEAT', 250_000n, 'elevator-e2e');
    await registry.lockReceipt(receipt.receiptId, instrumentId);

    const lockEnvelope = await latestEnvelope('RECEIPT_LOCKED');
    for (let replay = 0; replay < 1000; replay += 1) {
      const result = await publisher.publish(lockEnvelope, {
        correlationId: randomUUID(),
        idempotencyKey: lockEnvelope.eventId,
      });
      expect(result.replayed).toBe(true);
      expect(result.status).toBe('APPLIED');
    }

    const state = await pool.query<{
      oracle_count: string;
      audit_count: string;
      outbox_count: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM oracle_events
            WHERE source_id = $1 AND event_id::text = $2)::text AS oracle_count,
          (SELECT count(*) FROM event_log
            WHERE payload ->> 'eventId' = $2)::text AS audit_count,
          (SELECT count(*) FROM outbox
            WHERE payload ->> 'eventId' = $2)::text AS outbox_count
        `,
      [sourceId, lockEnvelope.eventId],
    );
    expect(state.rows[0]).toEqual({
      oracle_count: '1',
      audit_count: '1',
      outbox_count: '1',
    });

    const statuses = await pool.query<{ status: string }>(
      'SELECT status::text FROM oracle_events ORDER BY nonce',
    );
    expect(statuses.rows.map(({ status }) => status)).toEqual(['APPLIED', 'APPLIED']);
  }, 30_000);

  it('rejects a valid event after its signing key is revoked', async () => {
    const receipt = await registry.issueReceipt('owner-revoked', 'WHEAT', 100n, 'elevator-e2e');
    await registry.lockReceipt(receipt.receiptId, instrumentId);
    await pool.query(
      'UPDATE trusted_sources SET revoked_at = now() WHERE source_id = $1 AND key_id = $2',
      [sourceId, keyId],
    );

    await registry.releaseReceipt(receipt.receiptId, 'redemption-e2e');

    const rejected = await pool.query<{ status: string; failure_code: string }>(
      `
        SELECT status::text, failure_code
        FROM oracle_events
        WHERE source_id = $1 AND event_type = 'GOODS_RELEASED'
      `,
      [sourceId],
    );
    expect(rejected.rows[0]).toEqual({
      status: 'REJECTED',
      failure_code: 'ORACLE_SOURCE_KEY_REVOKED',
    });

    const effects = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_log WHERE payload ->> 'eventType' = 'GOODS_RELEASED'`,
    );
    expect(effects.rows[0]?.count).toBe('0');
  });

  async function latestEnvelope(eventType: string): Promise<OracleEventEnvelope> {
    const result = await pool.query<{ envelope: OracleEventEnvelope }>(
      `
        SELECT envelope
        FROM mock_ezr_http_outbox
        WHERE envelope ->> 'eventType' = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [eventType],
    );
    const envelope = result.rows[0]?.envelope;
    if (envelope === undefined) {
      throw new Error(`Missing mock event ${eventType}`);
    }
    return envelope;
  }
});

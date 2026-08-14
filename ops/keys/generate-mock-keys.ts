import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}

interface PgModule {
  Client: new (options: { connectionString: string }) => PgClient;
}

const sourceId = process.env.MOCK_EZR_SOURCE_ID ?? 'mock-ezr-registry';
const keyId = process.env.MOCK_EZR_KEY_ID ?? 'mock-ezr-key-1';
const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required so the public key can be trusted atomically');
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const privateKeyPath = resolve(scriptDirectory, 'private', `${sourceId}-${keyId}.pem`);
await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 });

const privateHandle = await open(privateKeyPath, 'wx', 0o600).catch((error: unknown) => {
  throw new Error(
    `Refusing to overwrite private key ${privateKeyPath}: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
});

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

try {
  await privateHandle.writeFile(privateKey, { encoding: 'utf8' });
  await privateHandle.close();

  const requireFromAdapters = createRequire(
    new URL('../../packages/adapters/package.json', import.meta.url),
  );
  const { Client } = requireFromAdapters('pg') as PgModule;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        INSERT INTO trusted_sources (source_id, key_id, algorithm, public_key_pem)
        VALUES ($1, $2, 'Ed25519', $3)
        ON CONFLICT (source_id, key_id) DO UPDATE
        SET algorithm = EXCLUDED.algorithm,
            public_key_pem = EXCLUDED.public_key_pem,
            created_at = now(),
            revoked_at = NULL
      `,
      [sourceId, keyId, publicKey],
    );
  } finally {
    await client.end();
  }
  process.stdout.write(`Generated ${sourceId}/${keyId}; private key: ${privateKeyPath}\n`);
} catch (error: unknown) {
  await privateHandle.close().catch(() => undefined);
  await unlink(privateKeyPath).catch(() => undefined);
  throw error;
} finally {
  await privateHandle.close().catch(() => undefined);
}

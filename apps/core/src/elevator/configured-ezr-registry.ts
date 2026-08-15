import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HttpOracleEventPublisher,
  PostgresEzrRegistry,
  type EzrRegistry,
  type Receipt,
} from '@commodity-chain/adapters';
import type { Pool } from 'pg';

export class ConfiguredEzrRegistry implements EzrRegistry {
  private delegate: PostgresEzrRegistry | undefined;

  public constructor(private readonly pool: Pool) {}

  public issueReceipt(
    owner: string,
    commodity: string,
    quantity: bigint,
    elevatorId: string,
  ): Promise<Receipt> {
    return this.registry().issueReceipt(owner, commodity, quantity, elevatorId);
  }

  public lockReceipt(receiptId: string, instrumentId: string): Promise<Receipt> {
    return this.registry().lockReceipt(receiptId, instrumentId);
  }

  public releaseReceipt(receiptId: string, redemptionId: string): Promise<Receipt> {
    return this.registry().releaseReceipt(receiptId, redemptionId);
  }

  public getReceipt(receiptId: string): Promise<Receipt | null> {
    return this.registry().getReceipt(receiptId);
  }

  private registry(): PostgresEzrRegistry {
    if (this.delegate !== undefined) return this.delegate;
    const privateKeyPath = resolve(
      process.env['MOCK_EZR_PRIVATE_KEY_PATH'] ?? 'ops/keys/private/mock-ezr-registry.pkcs8.pem',
    );
    this.delegate = new PostgresEzrRegistry({
      pool: this.pool,
      sourceId: configuredSourceId(),
      keyId: process.env['MOCK_EZR_KEY_ID'] ?? 'mock-ezr-key-1',
      privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
      oraclePublisher: new HttpOracleEventPublisher({
        baseUrl: process.env['CORE_INTERNAL_BASE_URL'] ?? 'http://127.0.0.1:3000',
        bearerToken: process.env['MOCK_EZR_ORACLE_TOKEN'] ?? 'local-mock-ezr',
      }),
      instrumentIdForReceipt: () => {
        throw new Error('Receipt issuance is not exposed by the elevator cabinet');
      },
      unitForCommodity: () => 'GRAM',
    });
    return this.delegate;
  }
}

export function configuredSourceId(): string {
  return process.env['MOCK_EZR_SOURCE_ID'] ?? 'mock-ezr-registry';
}

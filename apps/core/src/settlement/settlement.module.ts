import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PostgresLedger } from '@commodity-chain/ledger';
import { Pool } from 'pg';

import { SettlementCreatedConsumer } from './settlement-created.consumer.js';
import { SettlementService } from './settlement.service.js';

class SettlementDatabasePool extends Pool implements OnModuleDestroy {
  public constructor() {
    super({
      connectionString:
        process.env['DATABASE_URL'] ??
        'postgresql://postgres:postgres@127.0.0.1:5432/commodity_chain?sslmode=disable',
    });
  }

  public async onModuleDestroy(): Promise<void> {
    await this.end();
  }
}

@Module({
  providers: [
    SettlementDatabasePool,
    {
      provide: PostgresLedger,
      inject: [SettlementDatabasePool],
      useFactory: (pool: SettlementDatabasePool): PostgresLedger => new PostgresLedger(pool),
    },
    {
      provide: SettlementService,
      inject: [SettlementDatabasePool, PostgresLedger],
      useFactory: (pool: SettlementDatabasePool, ledger: PostgresLedger): SettlementService =>
        new SettlementService(pool, ledger),
    },
    SettlementCreatedConsumer,
  ],
  exports: [SettlementService, SettlementCreatedConsumer],
})
export class SettlementModule {}

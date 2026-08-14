import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { MintController } from '../instrument/mint.controller.js';
import { MintService } from '../instrument/mint.service.js';
import { AppliedOracleEventConsumer } from './applied-oracle-event.consumer.js';
import { PostgresCollateralLedger } from './collateral-ledger.service.js';

class CollateralDatabasePool extends Pool implements OnModuleDestroy {
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
  controllers: [MintController],
  providers: [
    CollateralDatabasePool,
    {
      provide: PostgresCollateralLedger,
      inject: [CollateralDatabasePool],
      useFactory: (pool: CollateralDatabasePool): PostgresCollateralLedger =>
        new PostgresCollateralLedger(pool),
    },
    {
      provide: MintService,
      inject: [CollateralDatabasePool, PostgresCollateralLedger],
      useFactory: (
        pool: CollateralDatabasePool,
        collateral: PostgresCollateralLedger,
      ): MintService => new MintService(pool, collateral),
    },
    AppliedOracleEventConsumer,
  ],
  exports: [AppliedOracleEventConsumer, PostgresCollateralLedger],
})
export class CollateralModule {}

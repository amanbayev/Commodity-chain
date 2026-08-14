import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { CollateralModule } from '../collateral/collateral.module.js';
import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { CollateralCoverageConsumer } from './collateral-coverage.consumer.js';
import { InstrumentController } from './instrument.controller.js';
import { InstrumentListingService } from './instrument-listing.service.js';

class InstrumentDatabasePool extends Pool implements OnModuleDestroy {
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
  imports: [CollateralModule],
  controllers: [InstrumentController],
  providers: [
    InstrumentDatabasePool,
    {
      provide: InstrumentListingService,
      inject: [InstrumentDatabasePool, PostgresCollateralLedger],
      useFactory: (
        pool: InstrumentDatabasePool,
        collateral: PostgresCollateralLedger,
      ): InstrumentListingService => new InstrumentListingService(pool, collateral),
    },
    CollateralCoverageConsumer,
  ],
  exports: [CollateralCoverageConsumer, InstrumentListingService],
})
export class InstrumentModule {}

import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PostgresLedger } from '@commodity-chain/ledger';
import { Pool } from 'pg';

import { PostgresCollateralLedger } from '../collateral/collateral-ledger.service.js';
import { GoodsReleasedRedemptionConsumer } from './redemption.consumers.js';
import { RedemptionController } from './redemption.controller.js';
import { RedemptionService } from './redemption.service.js';

class RedemptionDatabasePool extends Pool implements OnModuleDestroy {
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
  controllers: [RedemptionController],
  providers: [
    RedemptionDatabasePool,
    {
      provide: PostgresLedger,
      inject: [RedemptionDatabasePool],
      useFactory: (pool: RedemptionDatabasePool): PostgresLedger => new PostgresLedger(pool),
    },
    {
      provide: PostgresCollateralLedger,
      inject: [RedemptionDatabasePool],
      useFactory: (pool: RedemptionDatabasePool): PostgresCollateralLedger =>
        new PostgresCollateralLedger(pool),
    },
    {
      provide: RedemptionService,
      inject: [RedemptionDatabasePool, PostgresLedger, PostgresCollateralLedger],
      useFactory: (
        pool: RedemptionDatabasePool,
        ledger: PostgresLedger,
        collateral: PostgresCollateralLedger,
      ): RedemptionService =>
        new RedemptionService(pool, ledger, collateral, {
          deliveryTimeoutMs: Number(process.env['REDEMPTION_DELIVERY_TIMEOUT_MS'] ?? 604_800_000),
        }),
    },
    {
      provide: GoodsReleasedRedemptionConsumer,
      inject: [RedemptionService],
      useFactory: (service: RedemptionService): GoodsReleasedRedemptionConsumer =>
        new GoodsReleasedRedemptionConsumer(service),
    },
  ],
  exports: [RedemptionService, GoodsReleasedRedemptionConsumer],
})
export class RedemptionModule {}

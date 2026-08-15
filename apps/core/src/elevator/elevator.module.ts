import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { EzrRegistry } from '@commodity-chain/adapters';
import { Pool } from 'pg';

import { AppliedOracleEventConsumer } from '../collateral/applied-oracle-event.consumer.js';
import { CollateralModule } from '../collateral/collateral.module.js';
import { CollateralCoverageConsumer } from '../instrument/collateral-coverage.consumer.js';
import { InstrumentModule } from '../instrument/instrument.module.js';
import { GoodsReleasedRedemptionConsumer } from '../redemption/redemption.consumers.js';
import { RedemptionModule } from '../redemption/redemption.module.js';
import { RedemptionService } from '../redemption/redemption.service.js';
import { ConfiguredEzrRegistry, configuredSourceId } from './configured-ezr-registry.js';
import { ElevatorController } from './elevator.controller.js';
import { ElevatorService } from './elevator.service.js';

class ElevatorDatabasePool extends Pool implements OnModuleDestroy {
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

const EZR_REGISTRY = Symbol('EZR_REGISTRY');

@Module({
  imports: [CollateralModule, InstrumentModule, RedemptionModule],
  controllers: [ElevatorController],
  providers: [
    ElevatorDatabasePool,
    {
      provide: EZR_REGISTRY,
      inject: [ElevatorDatabasePool],
      useFactory: (pool: ElevatorDatabasePool): EzrRegistry => new ConfiguredEzrRegistry(pool),
    },
    {
      provide: ElevatorService,
      inject: [
        ElevatorDatabasePool,
        EZR_REGISTRY,
        AppliedOracleEventConsumer,
        CollateralCoverageConsumer,
        RedemptionService,
        GoodsReleasedRedemptionConsumer,
      ],
      useFactory: (
        pool: ElevatorDatabasePool,
        registry: EzrRegistry,
        collateral: AppliedOracleEventConsumer,
        coverage: CollateralCoverageConsumer,
        redemptions: RedemptionService,
        goodsReleased: GoodsReleasedRedemptionConsumer,
      ): ElevatorService =>
        new ElevatorService(pool, registry, collateral, coverage, redemptions, goodsReleased, {
          sourceId: configuredSourceId(),
        }),
    },
  ],
})
export class ElevatorModule {}

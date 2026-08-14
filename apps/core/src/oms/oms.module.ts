import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PostgresLedger } from '@commodity-chain/ledger';
import { Pool } from 'pg';

import { InstrumentCommandQueue } from './instrument-command-queue.js';
import { OmsService } from './oms.service.js';
import { OrderBookController, OrdersController } from './oms.controller.js';

class OmsDatabasePool extends Pool implements OnModuleDestroy {
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
  controllers: [OrdersController, OrderBookController],
  providers: [
    OmsDatabasePool,
    InstrumentCommandQueue,
    {
      provide: PostgresLedger,
      inject: [OmsDatabasePool],
      useFactory: (pool: OmsDatabasePool): PostgresLedger => new PostgresLedger(pool),
    },
    {
      provide: OmsService,
      inject: [OmsDatabasePool, PostgresLedger, InstrumentCommandQueue],
      useFactory: (
        pool: OmsDatabasePool,
        ledger: PostgresLedger,
        queue: InstrumentCommandQueue,
      ): OmsService => new OmsService(pool, ledger, queue),
    },
  ],
  exports: [OmsService],
})
export class OmsModule {}

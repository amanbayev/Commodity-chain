import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AcceptOracleEventUseCase } from './accept-oracle-event.use-case.js';
import { Ed25519SignatureVerifier } from './ed25519-verifier.js';
import { OracleGatewayController } from './oracle-gateway.controller.js';
import { PostgresOracleEventRepository } from './oracle-event.repository.js';
import { SYSTEM_CLOCK } from './oracle-event.types.js';
import { OpenApiOracleEnvelopeValidator } from './openapi-oracle-validator.js';

const DEFAULT_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

class OracleDatabasePool extends Pool implements OnModuleDestroy {
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
  controllers: [OracleGatewayController],
  providers: [
    OracleDatabasePool,
    {
      provide: AcceptOracleEventUseCase,
      inject: [OracleDatabasePool],
      useFactory: (pool: OracleDatabasePool): AcceptOracleEventUseCase =>
        new AcceptOracleEventUseCase(
          new PostgresOracleEventRepository(pool),
          new OpenApiOracleEnvelopeValidator(),
          new Ed25519SignatureVerifier(),
          SYSTEM_CLOCK,
          { freshnessWindowMs: configuredFreshnessWindowMs() },
        ),
    },
  ],
})
export class OracleGatewayModule {}

function configuredFreshnessWindowMs(): number {
  const configured = process.env['ORACLE_FRESHNESS_WINDOW_MS'];
  if (configured === undefined) {
    return DEFAULT_FRESHNESS_WINDOW_MS;
  }

  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('ORACLE_FRESHNESS_WINDOW_MS must be a positive safe integer');
  }
  return parsed;
}

import { Injectable } from '@nestjs/common';

import { CollateralError } from './collateral.errors.js';
import { PostgresCollateralLedger } from './collateral-ledger.service.js';
import type { OracleAppliedDomainEvent } from './collateral.types.js';

@Injectable()
export class AppliedOracleEventConsumer {
  public constructor(private readonly collateral: PostgresCollateralLedger) {}

  public async handle(event: OracleAppliedDomainEvent): Promise<void> {
    const quantity = parseQuantity(event.quantity);
    switch (event.eventType) {
      case 'RECEIPT_LOCKED':
        await this.collateral.reserve(event.assetId, event.instrumentId, quantity, event.eventId);
        return;
      case 'GOODS_RELEASED':
        if (event.redemptionId !== undefined) return;
        await this.collateral.release(event.assetId, event.instrumentId, quantity, event.eventId);
        return;
      default:
        return;
    }
  }
}

function parseQuantity(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new CollateralError(
      'INVALID_COLLATERAL_ARGUMENT',
      'Oracle quantity must be a positive integer string in minor units',
    );
  }
  return BigInt(value);
}

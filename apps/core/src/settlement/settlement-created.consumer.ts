import { Injectable } from '@nestjs/common';

import { SettlementService } from './settlement.service.js';
import type {
  SettlementCreatedDomainEvent,
  SettlementProcessingResult,
} from './settlement.types.js';

@Injectable()
export class SettlementCreatedConsumer {
  public constructor(private readonly settlements: SettlementService) {}

  public handle(event: SettlementCreatedDomainEvent): Promise<SettlementProcessingResult> {
    return this.settlements.handleCreatedEvent(event);
  }
}

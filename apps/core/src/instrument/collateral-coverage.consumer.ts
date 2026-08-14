import { Injectable } from '@nestjs/common';

import { InstrumentListingService } from './instrument-listing.service.js';
import type { CollateralReservedDomainEvent } from './instrument-listing.types.js';

@Injectable()
export class CollateralCoverageConsumer {
  public constructor(private readonly instruments: InstrumentListingService) {}

  public handle(event: CollateralReservedDomainEvent): Promise<boolean> {
    return this.instruments.applyCollateralReserved(event);
  }
}

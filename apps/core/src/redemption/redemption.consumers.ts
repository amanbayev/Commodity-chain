import type { EzrRegistry } from '@commodity-chain/adapters';

import { RedemptionService } from './redemption.service.js';
import type {
  RedemptionOracleAppliedEvent,
  RedemptionTokensLockedEvent,
} from './redemption.types.js';

export class RedemptionTokensLockedConsumer {
  public constructor(
    private readonly redemptions: RedemptionService,
    private readonly ezrRegistry: EzrRegistry,
  ) {}

  public async handle(event: RedemptionTokensLockedEvent): Promise<void> {
    const receiptId = await this.redemptions.prepareDelivery(
      event.redemptionId,
      event.correlationId,
    );
    await this.ezrRegistry.releaseReceipt(receiptId, event.redemptionId);
  }
}

export class GoodsReleasedRedemptionConsumer {
  public constructor(private readonly redemptions: RedemptionService) {}

  public async handle(event: RedemptionOracleAppliedEvent): Promise<void> {
    if (event.eventType !== 'GOODS_RELEASED' || event.redemptionId === undefined) return;
    await this.redemptions.applyGoodsReleased(event);
  }
}

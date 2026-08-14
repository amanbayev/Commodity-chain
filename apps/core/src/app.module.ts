import { Module } from '@nestjs/common';

import { CollateralModule } from './collateral/collateral.module.js';
import { OracleGatewayModule } from './oracle-gateway/oracle-gateway.module.js';

@Module({ imports: [OracleGatewayModule, CollateralModule] })
export class AppModule {}

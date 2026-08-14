import { Module } from '@nestjs/common';

import { InstrumentModule } from './instrument/instrument.module.js';
import { OmsModule } from './oms/oms.module.js';
import { OracleGatewayModule } from './oracle-gateway/oracle-gateway.module.js';

@Module({ imports: [OracleGatewayModule, InstrumentModule, OmsModule] })
export class AppModule {}

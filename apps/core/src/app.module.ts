import { Module } from '@nestjs/common';

import { InstrumentModule } from './instrument/instrument.module.js';
import { OracleGatewayModule } from './oracle-gateway/oracle-gateway.module.js';

@Module({ imports: [OracleGatewayModule, InstrumentModule] })
export class AppModule {}

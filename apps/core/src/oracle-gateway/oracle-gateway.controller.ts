import { Body, Controller, Headers, Post, Res } from '@nestjs/common';

import { AcceptOracleEventUseCase } from './accept-oracle-event.use-case.js';

interface PassthroughResponse {
  status(statusCode: number): this;
  setHeader(name: string, value: string): this;
}

@Controller('oracle-events')
export class OracleGatewayController {
  public constructor(private readonly acceptOracleEvent: AcceptOracleEventUseCase) {}

  @Post()
  public async accept(
    @Body() payload: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Headers('x-oracle-signature') detachedSignature: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const result = await this.acceptOracleEvent.execute({
      payload,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId ?? '',
      detachedSignature: detachedSignature ?? '',
    });

    response.status(result.httpStatus);
    response.setHeader('X-Correlation-Id', correlationId ?? '');
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }
}

import { Body, Controller, Delete, Headers, Param, Post, Res } from '@nestjs/common';

import { RedemptionService } from './redemption.service.js';
import type {
  CreateRedemptionCommand,
  PhysicalDeliveryDetails,
  RedemptionExecutionResult,
} from './redemption.types.js';

interface PassthroughResponse {
  status(statusCode: number): this;
  setHeader(name: string, value: string): this;
}

@Controller('redemptions')
export class RedemptionController {
  public constructor(private readonly redemptions: RedemptionService) {}

  @Post()
  public async create(
    @Body() body: unknown,
    @Headers('x-holder-id') holderId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const correlation = correlationId ?? '';
    const parsed = parseCreate(body, holderId ?? '', idempotencyKey ?? '', correlation);
    const result =
      parsed === null ? invalidRequest(correlation) : await this.redemptions.create(parsed);
    applyResponse(response, result, correlation);
    return result.body;
  }

  @Delete(':id')
  public async cancel(
    @Param('id') redemptionId: string,
    @Headers('x-holder-id') holderId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const correlation = correlationId ?? '';
    const result = await this.redemptions.cancel({
      redemptionId,
      holderId: holderId ?? '',
      correlationId: correlation,
    });
    applyResponse(response, result, correlation);
    return result.body;
  }
}

function parseCreate(
  body: unknown,
  holderId: string,
  idempotencyKey: string,
  correlationId: string,
): CreateRedemptionCommand | null {
  if (
    !isRecord(body) ||
    !only(body, [
      'holder',
      'instrumentId',
      'quantity',
      'method',
      'delivery',
      'proofs',
      'extensions',
    ]) ||
    body['holder'] !== holderId ||
    typeof body['instrumentId'] !== 'string' ||
    typeof body['quantity'] !== 'string' ||
    !/^[1-9][0-9]*$/u.test(body['quantity']) ||
    body['method'] !== 'PHYSICAL_DELIVERY' ||
    !isDelivery(body['delivery']) ||
    !Array.isArray(body['proofs']) ||
    !body['proofs'].every(isRecord) ||
    (body['extensions'] !== undefined && !isRecord(body['extensions']))
  ) {
    return null;
  }
  return {
    holderId,
    instrumentId: body['instrumentId'],
    quantity: BigInt(body['quantity']),
    method: body['method'],
    delivery: body['delivery'],
    proofs: body['proofs'],
    idempotencyKey,
    correlationId,
  };
}

function isDelivery(value: unknown): value is PhysicalDeliveryDetails {
  return (
    isRecord(value) &&
    only(value, ['elevatorId', 'requestedDate', 'recipient', 'transport']) &&
    typeof value['elevatorId'] === 'string' &&
    typeof value['requestedDate'] === 'string' &&
    typeof value['recipient'] === 'string' &&
    typeof value['transport'] === 'string'
  );
}

function invalidRequest(correlationId: string): RedemptionExecutionResult {
  return {
    httpStatus: 400,
    replayed: false,
    body: {
      code: 'VALIDATION_ERROR',
      message: 'Request body does not match RedemptionCreateRequest',
      correlationId,
      details: [{ reason: 'Request body does not match RedemptionCreateRequest' }],
    },
  };
}

function applyResponse(
  response: PassthroughResponse,
  result: RedemptionExecutionResult,
  correlationId: string,
): void {
  response.status(result.httpStatus);
  response.setHeader('X-Correlation-Id', correlationId);
  response.setHeader('Idempotency-Replayed', String(result.replayed));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function only(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

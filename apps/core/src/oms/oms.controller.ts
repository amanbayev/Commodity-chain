import { Body, Controller, Delete, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';

import { OmsError } from './oms.errors.js';
import { OmsService } from './oms.service.js';
import type { OmsExecutionResult, PlaceOrderCommand } from './oms.types.js';

interface PassthroughResponse {
  status(statusCode: number): this;
  setHeader(name: string, value: string): this;
}

@Controller('orders')
export class OrdersController {
  public constructor(private readonly oms: OmsService) {}

  @Get()
  public async list(
    @Headers('x-participant-id') participantId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limitValue: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const correlation = correlationId ?? '';
    response.setHeader('X-Correlation-Id', correlation);
    try {
      const body = await this.oms.listOrders(participantId ?? '', cursor, parseLimit(limitValue));
      response.status(200);
      return body;
    } catch (error: unknown) {
      if (!(error instanceof OmsError)) throw error;
      response.status(error.httpStatus);
      return {
        code: error.code,
        message: error.message,
        correlationId: correlation,
        details: error.details,
      };
    }
  }

  @Post()
  public async place(
    @Body() payload: unknown,
    @Headers('x-participant-id') participantId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const command = parsePlace(
      payload,
      participantId ?? '',
      idempotencyKey ?? '',
      correlationId ?? '',
    );
    const result =
      command === null
        ? invalidRequest(correlationId ?? '', 'Request body does not match OrderCreateRequest')
        : await this.oms.place(command);
    response.status(result.httpStatus);
    response.setHeader('X-Correlation-Id', correlationId ?? '');
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }

  @Delete(':id')
  public async cancel(
    @Param('id') orderId: string,
    @Headers('x-participant-id') participantId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const result = await this.oms.cancel({
      orderId,
      participantId: participantId ?? '',
      correlationId: correlationId ?? '',
    });
    response.status(result.httpStatus);
    response.setHeader('X-Correlation-Id', correlationId ?? '');
    return result.body;
  }
}

@Controller('orderbook')
export class OrderBookController {
  public constructor(private readonly oms: OmsService) {}

  @Get(':instrumentId')
  public async snapshot(
    @Param('instrumentId') instrumentId: string,
    @Query('depth') depthValue: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const correlation = correlationId ?? '';
    response.setHeader('X-Correlation-Id', correlation);
    try {
      const depth = depthValue === undefined ? 20 : Number(depthValue);
      const body = await this.oms.orderBook(instrumentId, depth);
      response.status(200);
      return body;
    } catch (error: unknown) {
      if (!(error instanceof OmsError)) throw error;
      response.status(error.httpStatus);
      return {
        code: error.code,
        message: error.message,
        correlationId: correlation,
        details: error.details,
      };
    }
  }
}

function parsePlace(
  payload: unknown,
  participantId: string,
  idempotencyKey: string,
  correlationId: string,
): PlaceOrderCommand | null {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, [
      'clientOrderId',
      'instrumentId',
      'side',
      'type',
      'price',
      'quantity',
      'extensions',
    ]) ||
    typeof payload['clientOrderId'] !== 'string' ||
    typeof payload['instrumentId'] !== 'string' ||
    (payload['side'] !== 'BUY' && payload['side'] !== 'SELL') ||
    (payload['type'] !== 'LIMIT' && payload['type'] !== 'MARKET') ||
    !isPositiveIntegerString(payload['quantity']) ||
    (payload['price'] !== undefined && !isPositiveIntegerString(payload['price'])) ||
    (payload['type'] === 'LIMIT' && !isPositiveIntegerString(payload['price'])) ||
    (payload['extensions'] !== undefined && !isRecord(payload['extensions']))
  ) {
    return null;
  }
  return {
    participantId,
    clientOrderId: payload['clientOrderId'],
    instrumentId: payload['instrumentId'],
    side: payload['side'],
    type: payload['type'],
    ...(payload['price'] === undefined ? {} : { price: BigInt(payload['price']) }),
    quantity: BigInt(payload['quantity']),
    ...(payload['extensions'] === undefined ? {} : { extensions: payload['extensions'] }),
    idempotencyKey,
    correlationId,
  };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new OmsError('VALIDATION_ERROR', 'limit must be an integer between 1 and 200', 400);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 200) {
    throw new OmsError('VALIDATION_ERROR', 'limit must be an integer between 1 and 200', 400);
  }
  return limit;
}

function invalidRequest(correlationId: string, message: string): OmsExecutionResult {
  return {
    httpStatus: 400,
    replayed: false,
    body: {
      code: 'VALIDATION_ERROR',
      message,
      correlationId,
      details: [{ reason: message }],
    },
  };
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

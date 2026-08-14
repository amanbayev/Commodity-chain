import { Body, Controller, Headers, Param, Post, Res } from '@nestjs/common';

import { MintService } from './mint.service.js';
import type { MintCollateralProof, MintCommand, MintExecutionResult } from './mint.types.js';

interface PassthroughResponse {
  status(statusCode: number): this;
  setHeader(name: string, value: string): this;
}

@Controller('instruments')
export class MintController {
  public constructor(private readonly mint: MintService) {}

  @Post(':id/mint')
  public async create(
    @Param('id') instrumentId: string,
    @Body() payload: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    const command = parseCommand(instrumentId, payload, idempotencyKey ?? '', correlationId ?? '');
    const result =
      command === null ? invalidRequest(correlationId ?? '') : await this.mint.execute(command);

    response.status(result.httpStatus);
    response.setHeader('X-Correlation-Id', correlationId ?? '');
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }
}

function parseCommand(
  instrumentId: string,
  payload: unknown,
  idempotencyKey: string,
  correlationId: string,
): MintCommand | null {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['quantity', 'unit', 'collateralProof'])) {
    return null;
  }
  const proof = parseProof(payload['collateralProof']);
  if (
    typeof payload['quantity'] !== 'string' ||
    !/^[1-9][0-9]*$/u.test(payload['quantity']) ||
    typeof payload['unit'] !== 'string' ||
    proof === null
  ) {
    return null;
  }
  return {
    instrumentId,
    quantity: BigInt(payload['quantity']),
    unit: payload['unit'],
    collateralProof: proof,
    idempotencyKey,
    correlationId,
  };
}

function parseProof(value: unknown): MintCollateralProof | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'assetId',
      'instrumentId',
      'reserved',
      'unit',
      'evidenceHash',
      'verifierProofs',
      'extensions',
    ]) ||
    typeof value['assetId'] !== 'string' ||
    typeof value['instrumentId'] !== 'string' ||
    typeof value['reserved'] !== 'string' ||
    typeof value['unit'] !== 'string' ||
    typeof value['evidenceHash'] !== 'string' ||
    !Array.isArray(value['verifierProofs'])
  ) {
    return null;
  }
  return {
    assetId: value['assetId'],
    instrumentId: value['instrumentId'],
    reserved: value['reserved'],
    unit: value['unit'],
    evidenceHash: value['evidenceHash'],
    verifierProofs: value['verifierProofs'],
  };
}

function invalidRequest(correlationId: string): MintExecutionResult {
  const message = 'Request body does not match MintRequest';
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

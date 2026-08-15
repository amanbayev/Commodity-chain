import { Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';

import { instrumentResponseToJson } from '../instrument/instrument-response.mapper.js';
import { ElevatorError } from './elevator.errors.js';
import { ElevatorService } from './elevator.service.js';

interface PassthroughResponse {
  status(code: number): this;
  setHeader(name: string, value: string): this;
}

@Controller('elevators')
export class ElevatorController {
  public constructor(private readonly elevators: ElevatorService) {}

  @Get(':elevatorId/dashboard')
  public dashboard(
    @Param('elevatorId') elevatorId: string,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 200, actorId, elevatorId, () =>
      this.elevators.dashboard(elevatorId),
    );
  }

  @Get(':elevatorId/verification-requests')
  public verifications(
    @Param('elevatorId') elevatorId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 200, actorId, elevatorId, () =>
      this.elevators.listVerificationRequests(elevatorId, cursor, parseLimit(limit)),
    );
  }

  @Get(':elevatorId/verification-requests/:requestId')
  public verification(
    @Param('elevatorId') elevatorId: string,
    @Param('requestId') requestId: string,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 200, actorId, elevatorId, () =>
      this.elevators.getVerificationRequest(elevatorId, requestId),
    );
  }

  @Post(':elevatorId/verification-requests/:requestId/reserve')
  public reserve(
    @Param('elevatorId') elevatorId: string,
    @Param('requestId') requestId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 202, actorId, elevatorId, () => {
      requireIdempotencyKey(idempotencyKey);
      return this.elevators.reserve(elevatorId, requestId, correlationId ?? '');
    });
  }

  @Get(':elevatorId/shipments')
  public shipments(
    @Param('elevatorId') elevatorId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 200, actorId, elevatorId, () =>
      this.elevators.listShipments(elevatorId, cursor, parseLimit(limit)),
    );
  }

  @Get(':elevatorId/shipments/:redemptionId')
  public shipment(
    @Param('elevatorId') elevatorId: string,
    @Param('redemptionId') redemptionId: string,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 200, actorId, elevatorId, () =>
      this.elevators.getShipment(elevatorId, redemptionId),
    );
  }

  @Post(':elevatorId/shipments/:redemptionId/confirm')
  public confirm(
    @Param('elevatorId') elevatorId: string,
    @Param('redemptionId') redemptionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 202, actorId, elevatorId, () => {
      requireIdempotencyKey(idempotencyKey);
      return this.elevators.confirmShipment(elevatorId, redemptionId, correlationId ?? '');
    });
  }

  @Get(':elevatorId/oracle-events')
  public events(
    @Param('elevatorId') elevatorId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId, 200, actorId, elevatorId, () =>
      this.elevators.listOracleEvents(elevatorId, cursor, parseLimit(limit)),
    );
  }

  private async respond(
    response: PassthroughResponse,
    correlationId: string | undefined,
    successStatus: number,
    actorId: string | undefined,
    elevatorId: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const correlation = correlationId ?? '';
    response.setHeader('X-Correlation-Id', correlation);
    try {
      if (actorId !== elevatorId)
        throw new ElevatorError('PERMISSION_DENIED', 'Elevator access denied', 403);
      const body = instrumentResponseToJson(await operation());
      response.status(successStatus);
      return body;
    } catch (error: unknown) {
      if (!(error instanceof ElevatorError)) throw error;
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

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]*$/u.test(value))
    throw new ElevatorError('VALIDATION_ERROR', 'limit is invalid', 400);
  return Number(value);
}

function requireIdempotencyKey(value: string | undefined): void {
  if (value === undefined || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new ElevatorError('VALIDATION_ERROR', 'Idempotency-Key is required', 400);
  }
}

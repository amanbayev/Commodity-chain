import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res } from '@nestjs/common';

import { InstrumentListingError } from './instrument-listing.errors.js';
import { InstrumentListingService } from './instrument-listing.service.js';
import { instrumentResponseToJson } from './instrument-response.mapper.js';
import type {
  CreateInstrumentDraftCommand,
  UpdateInstrumentDraftCommand,
} from './instrument-listing.types.js';
import { parsePassportDraft } from './instrument-passport.js';
import type { LegalNature } from './instrument-passport.js';

interface PassthroughResponse {
  status(statusCode: number): this;
  setHeader(name: string, value: string): this;
}

const LEGAL_NATURES = new Set<LegalNature>([
  'CLAIM_RIGHT',
  'OWNERSHIP',
  'INCOME_SHARE',
  'LICENSE',
  'ACCESS',
  'DIGITAL_GOOD',
  'INVESTMENT',
]);

@Controller('instruments')
export class InstrumentController {
  public constructor(private readonly instruments: InstrumentListingService) {}

  @Get()
  public async listMarket(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limitValue: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 200, () =>
      this.instruments.listMarketInstruments(cursor, parseLimit(limitValue)),
    );
  }

  @Post('drafts')
  public async createDraft(
    @Body() payload: unknown,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 201, async () => {
      const command = parseDraft(payload, actorId ?? '', correlationId ?? '');
      if (command === null) throw invalidBody('InstrumentDraftCreate');
      return this.instruments.createDraft(command);
    });
  }

  @Get('issues')
  public async issues(
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limitValue: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 200, () =>
      this.instruments.listIssuerInstruments(actorId ?? '', cursor, parseLimit(limitValue)),
    );
  }

  @Patch(':id/draft')
  public async updateDraft(
    @Param('id') instrumentId: string,
    @Body() payload: unknown,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 200, async () => {
      const command = parseDraftUpdate(instrumentId, payload, actorId ?? '', correlationId ?? '');
      if (command === null) throw invalidBody('InstrumentDraftUpdate');
      return this.instruments.updateDraft(command);
    });
  }

  @Get(':id/issue')
  public async issue(
    @Param('id') instrumentId: string,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 200, () =>
      this.instruments.getIssuerInstrument(instrumentId, actorId ?? ''),
    );
  }

  @Get(':id/collateral')
  public async collateral(
    @Param('id') instrumentId: string,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 200, () =>
      this.instruments.getCollateralSummary(instrumentId, actorId ?? ''),
    );
  }

  @Post(':id/submit')
  public async submit(
    @Param('id') instrumentId: string,
    @Body() payload: unknown,
    @Headers('x-actor-id') actorId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 202, async () => {
      if (
        !isRecord(payload) ||
        !hasOnlyKeys(payload, ['version', 'submissionNote']) ||
        !Number.isSafeInteger(payload['version']) ||
        (payload['version'] as number) <= 0 ||
        (payload['submissionNote'] !== undefined && typeof payload['submissionNote'] !== 'string')
      ) {
        throw invalidBody('InstrumentSubmitRequest');
      }
      return this.instruments.submit({
        instrumentId,
        version: BigInt(payload['version'] as number),
        ...(payload['submissionNote'] === undefined
          ? {}
          : { submissionNote: payload['submissionNote'] as string }),
        actorId: actorId ?? '',
        correlationId: correlationId ?? '',
      });
    });
  }

  @Get(':id/passport')
  public async passport(
    @Param('id') instrumentId: string,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughResponse,
  ): Promise<unknown> {
    return this.respond(response, correlationId ?? '', 200, () =>
      this.instruments.getPublicPassport(instrumentId),
    );
  }

  private async respond(
    response: PassthroughResponse,
    correlationId: string,
    successStatus: number,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    response.setHeader('X-Correlation-Id', correlationId);
    try {
      const body = instrumentResponseToJson(await operation());
      response.status(successStatus);
      return body;
    } catch (error: unknown) {
      if (!(error instanceof InstrumentListingError)) throw error;
      response.status(error.httpStatus);
      return {
        code: error.code,
        message: error.message,
        correlationId,
        details: error.details,
      };
    }
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]*$/u.test(value)) throw invalidBody('CursorPageLimit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 200) throw invalidBody('CursorPageLimit');
  return limit;
}

function parseDraft(
  payload: unknown,
  actorId: string,
  correlationId: string,
): CreateInstrumentDraftCommand | null {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, [
      'type',
      'legalNature',
      'currency',
      'unit',
      'unitPerToken',
      'supplyCap',
      'passport',
      'extensions',
    ]) ||
    typeof payload['type'] !== 'string' ||
    !isLegalNature(payload['legalNature']) ||
    typeof payload['currency'] !== 'string' ||
    typeof payload['unit'] !== 'string' ||
    !isPositiveIntegerString(payload['unitPerToken']) ||
    !isPositiveIntegerString(payload['supplyCap']) ||
    (payload['extensions'] !== undefined && !isRecord(payload['extensions']))
  ) {
    return null;
  }
  const passport = parsePassportDraft(payload['passport']);
  if (passport === null) return null;
  return {
    type: payload['type'],
    legalNature: payload['legalNature'],
    currency: payload['currency'],
    unit: payload['unit'],
    unitPerToken: BigInt(payload['unitPerToken']),
    supplyCap: BigInt(payload['supplyCap']),
    passport,
    ...(payload['extensions'] === undefined ? {} : { extensions: payload['extensions'] }),
    actorId,
    correlationId,
  };
}

function parseDraftUpdate(
  instrumentId: string,
  payload: unknown,
  actorId: string,
  correlationId: string,
): UpdateInstrumentDraftCommand | null {
  if (!isRecord(payload) || !Number.isSafeInteger(payload['version'])) return null;
  const { version, ...draftPayload } = payload;
  const draft = parseDraft(draftPayload, actorId, correlationId);
  if (draft === null || (version as number) <= 0) return null;
  return { ...draft, instrumentId, version: BigInt(version as number) };
}

function invalidBody(schema: string): InstrumentListingError {
  const message = `Request body does not match ${schema}`;
  return new InstrumentListingError('VALIDATION_ERROR', message, 400, [{ reason: message }]);
}

function isLegalNature(value: unknown): value is LegalNature {
  return typeof value === 'string' && LEGAL_NATURES.has(value as LegalNature);
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

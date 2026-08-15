import type { InstrumentStatus } from './instrument-state-machine.js';
import type { InstrumentView, LegalNature, PassportDraft } from './instrument-passport.js';

export interface CreateInstrumentDraftCommand {
  readonly type: string;
  readonly legalNature: LegalNature;
  readonly currency: string;
  readonly unit: string;
  readonly unitPerToken: bigint;
  readonly supplyCap: bigint;
  readonly passport: PassportDraft;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly actorId: string;
  readonly correlationId: string;
}

export interface SubmitInstrumentCommand {
  readonly instrumentId: string;
  readonly version: bigint;
  readonly submissionNote?: string;
  readonly actorId: string;
  readonly correlationId: string;
}

export interface UpdateInstrumentDraftCommand extends CreateInstrumentDraftCommand {
  readonly instrumentId: string;
  readonly version: bigint;
}

export interface ReviewCommand {
  readonly instrumentId: string;
  readonly operatorId: string;
  readonly comment: string;
  readonly correlationId: string;
}

export interface RevisePassportCommand {
  readonly instrumentId: string;
  readonly passport: PassportDraft;
  readonly actorId: string;
  readonly reason: string;
  readonly correlationId: string;
}

export interface InternalTransitionCommand {
  readonly instrumentId: string;
  readonly targetStatus: InstrumentStatus;
  readonly actorId: string;
  readonly reason: string;
  readonly correlationId: string;
}

export interface CollateralReservedDomainEvent {
  readonly eventId: string;
  readonly nonce: string;
  readonly instrumentId: string;
  readonly correlationId: string;
}

export interface InstrumentDraftResult {
  readonly instrument: InstrumentView;
  readonly passport: Readonly<Record<string, unknown>>;
  readonly version: number;
}

export interface InstrumentSubmissionResult extends InstrumentDraftResult {
  readonly passportHash: string;
  readonly submittedAt: string;
}

export interface ReviewResult {
  readonly instrument: InstrumentView;
  readonly passportVersion: number;
  readonly decision: 'APPROVE' | 'REJECT' | 'RETURN_FOR_REVISION';
  readonly distinctApprovalCount: number;
}

export interface PublicPassportResult {
  readonly instrument: InstrumentView;
  readonly passport: Readonly<Record<string, unknown>>;
  readonly passportHash: string;
  readonly version: number;
  readonly assets: readonly Readonly<Record<string, unknown>>[];
  readonly collateralPositions: readonly Readonly<Record<string, unknown>>[];
  readonly publishedAt: string;
}

export interface InstrumentMarketItem {
  readonly instrument: InstrumentView;
  readonly ticker?: string;
  readonly name: string;
  readonly lastTradePrice?: string;
  readonly priceChangeBps?: string;
  readonly availableSupply: string;
  readonly tradingVolume24h: string;
}

export interface InstrumentMarketPage {
  readonly items: readonly InstrumentMarketItem[];
  readonly page: {
    readonly nextCursor?: string;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface IssuerInstrumentResult {
  readonly instrument: InstrumentView;
  readonly passport: Readonly<Record<string, unknown>>;
  readonly passportHash?: string;
  readonly version: number;
  readonly collateralPositions: readonly Readonly<Record<string, unknown>>[];
  readonly verifiedAvailable: string;
}

export interface IssuerInstrumentPage {
  readonly items: readonly Omit<IssuerInstrumentResult, 'collateralPositions'>[];
  readonly page: {
    readonly nextCursor?: string;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface CollateralSummaryResult {
  readonly instrumentId: string;
  readonly verifiedAvailable: string;
  readonly positions: readonly Readonly<Record<string, unknown>>[];
}

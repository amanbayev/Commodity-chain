import { OmsError } from './oms.errors.js';

export interface AdmissionFacts {
  readonly participantId: string;
  readonly participantExists: boolean;
  readonly instrumentId: string;
  readonly instrumentStatus: string | null;
  readonly tradeable: boolean;
}

export function assertOrderAdmission(facts: AdmissionFacts): void {
  if (!facts.participantExists) {
    throw new OmsError(
      'PARTICIPANT_NOT_FOUND',
      `Participant ${facts.participantId} was not found`,
      404,
    );
  }
  if (facts.instrumentStatus === null) {
    throw new OmsError('RESOURCE_NOT_FOUND', `Instrument ${facts.instrumentId} was not found`, 404);
  }
  if (facts.instrumentStatus !== 'PRIMARY' && facts.instrumentStatus !== 'ACTIVE') {
    throw new OmsError(
      'INVALID_STATUS',
      `Instrument status ${facts.instrumentStatus} does not allow order entry`,
      409,
    );
  }
  if (!facts.tradeable) {
    throw new OmsError(
      'INSTRUMENT_NOT_TRADABLE',
      `Instrument ${facts.instrumentId} does not have complete trading configuration`,
      422,
    );
  }
}

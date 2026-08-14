export const INSTRUMENT_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'COLLATERALIZED',
  'PRIMARY',
  'ACTIVE',
  'SUSPENDED',
  'REDEMPTION',
  'MATURED',
  'CLOSED',
  'DEFAULT',
] as const;

export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

export interface InstrumentLifecycleState {
  readonly status: InstrumentStatus;
  readonly suspendedFrom: InstrumentStatus | null;
}

const FORWARD_TRANSITIONS: Readonly<
  Partial<Record<InstrumentStatus, readonly InstrumentStatus[]>>
> = {
  DRAFT: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED'],
  APPROVED: ['COLLATERALIZED'],
  COLLATERALIZED: ['PRIMARY'],
  PRIMARY: ['ACTIVE'],
  ACTIVE: ['REDEMPTION'],
  REDEMPTION: ['MATURED', 'CLOSED'],
};

const SUSPENDABLE = new Set<InstrumentStatus>([
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'COLLATERALIZED',
  'PRIMARY',
  'ACTIVE',
  'REDEMPTION',
  'MATURED',
  'CLOSED',
  'DEFAULT',
]);

export class InvalidInstrumentTransitionError extends Error {
  public readonly code = 'INVALID_TRANSITION' as const;

  public constructor(
    public readonly from: InstrumentStatus,
    public readonly to: InstrumentStatus,
  ) {
    super(`Instrument transition ${from} -> ${to} is not allowed`);
    this.name = 'InvalidInstrumentTransitionError';
  }
}

export function transitionInstrument(
  current: InstrumentLifecycleState,
  target: InstrumentStatus,
): InstrumentLifecycleState {
  if (current.status === 'SUSPENDED') {
    if (current.suspendedFrom !== null && target === current.suspendedFrom) {
      return { status: target, suspendedFrom: null };
    }
    throw new InvalidInstrumentTransitionError(current.status, target);
  }

  if (target === 'SUSPENDED' && SUSPENDABLE.has(current.status)) {
    return { status: 'SUSPENDED', suspendedFrom: current.status };
  }

  if (FORWARD_TRANSITIONS[current.status]?.includes(target) === true) {
    return { status: target, suspendedFrom: null };
  }

  throw new InvalidInstrumentTransitionError(current.status, target);
}

export function isInstrumentStatus(value: unknown): value is InstrumentStatus {
  return typeof value === 'string' && (INSTRUMENT_STATUSES as readonly string[]).includes(value);
}

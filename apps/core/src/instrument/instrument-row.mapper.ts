import type { QueryResultRow } from 'pg';

import type { InstrumentView, LegalNature } from './instrument-passport.js';
import { isInstrumentStatus } from './instrument-state-machine.js';

export interface InstrumentDatabaseRow extends QueryResultRow {
  readonly id: string;
  readonly type: string;
  readonly legal_nature: LegalNature;
  readonly status: string;
  readonly currency: string;
  readonly unit: string;
  readonly unit_per_token: string;
  readonly supply_cap: string;
  readonly circulating_supply: string;
  readonly version: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export function rowToInstrument(row: InstrumentDatabaseRow): InstrumentView {
  if (!isInstrumentStatus(row.status)) {
    throw new Error(`Unknown persisted instrument status ${row.status}`);
  }
  return {
    id: row.id,
    type: row.type,
    legalNature: row.legal_nature,
    status: row.status,
    currency: row.currency,
    unit: row.unit,
    unitPerToken: BigInt(row.unit_per_token),
    supplyCap: BigInt(row.supply_cap),
    circulatingSupply: BigInt(row.circulating_supply),
    version: safeVersion(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    extensions: row.extensions,
  };
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`Instrument version ${value} cannot be represented safely`);
  }
  return version;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

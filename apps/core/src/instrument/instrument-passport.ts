import { createHash } from 'node:crypto';

import { canonicalizeJson } from '../oracle-gateway/canonical-json.js';
import type { InstrumentStatus } from './instrument-state-machine.js';

export type LegalNature =
  | 'CLAIM_RIGHT'
  | 'OWNERSHIP'
  | 'INCOME_SHARE'
  | 'LICENSE'
  | 'ACCESS'
  | 'DIGITAL_GOOD'
  | 'INVESTMENT';

export interface UnderlyingAssetPassport {
  readonly assetClass: string;
  readonly commodity: string;
  readonly grade: string;
  readonly originCountry: string;
  readonly unit: string;
  readonly storageLocation: string;
  readonly qualityStandard?: string;
}

export interface HolderRightsPassport {
  readonly legalTitle: LegalNature;
  readonly claimDescription: string;
  readonly governingLaw: string;
  readonly redemptionMethods: readonly ('PHYSICAL_DELIVERY' | 'CASH' | 'DIGITAL_ACTIVATION')[];
  readonly transferRestrictions: readonly string[];
}

export interface CustodyAndVerificationPassport {
  readonly custodianId: string;
  readonly registryId: string;
  readonly verifierIds: readonly string[];
  readonly evidenceRequirements?: readonly string[];
}

export interface PassportFee {
  readonly feeType: string;
  readonly amount: bigint;
  readonly currency: string;
}

export interface InstrumentEconomicsPassport {
  readonly issuePrice: bigint;
  readonly issueCurrency: string;
  readonly maturityDate: string;
  readonly feeSchedule: readonly PassportFee[];
}

export interface TradingParametersPassport {
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minimumOrderQuantity: bigint;
  readonly minimumDeliveryQuantity: bigint;
  readonly settlementCycle: 'T_PLUS_0' | 'T_PLUS_1' | 'T_PLUS_2';
}

export interface PassportDraft {
  readonly underlyingAsset?: UnderlyingAssetPassport;
  readonly holderRights?: HolderRightsPassport;
  readonly custodyAndVerification?: CustodyAndVerificationPassport;
  readonly economics?: InstrumentEconomicsPassport;
  readonly tradingParameters?: TradingParametersPassport;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type CompletePassport = Required<
  Pick<
    PassportDraft,
    | 'underlyingAsset'
    | 'holderRights'
    | 'custodyAndVerification'
    | 'economics'
    | 'tradingParameters'
  >
> &
  Pick<PassportDraft, 'extensions'>;

export interface InstrumentHashFields {
  readonly id: string;
  readonly type: string;
  readonly legalNature: LegalNature;
  readonly currency: string;
  readonly unit: string;
  readonly unitPerToken: bigint;
  readonly supplyCap: bigint;
  readonly version: bigint;
}

export interface InstrumentView {
  readonly id: string;
  readonly type: string;
  readonly legalNature: LegalNature;
  readonly status: InstrumentStatus;
  readonly currency: string;
  readonly unit: string;
  readonly unitPerToken: string;
  readonly supplyCap: string;
  readonly circulatingSupply: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export const REQUIRED_PASSPORT_SECTIONS = [
  'passport.underlyingAsset',
  'passport.holderRights',
  'passport.custodyAndVerification',
  'passport.economics',
  'passport.tradingParameters',
] as const;

export function missingPassportFields(passport: PassportDraft): readonly string[] {
  const missing: string[] = [];
  if (passport.underlyingAsset === undefined) {
    missing.push('passport.underlyingAsset');
  }
  if (passport.holderRights === undefined) {
    missing.push('passport.holderRights');
  }
  if (passport.custodyAndVerification === undefined) {
    missing.push('passport.custodyAndVerification');
  }
  if (passport.economics === undefined) {
    missing.push('passport.economics');
  }
  if (passport.tradingParameters === undefined) {
    missing.push('passport.tradingParameters');
  }
  return missing;
}

export function assertCompletePassport(passport: PassportDraft): CompletePassport {
  const missing = missingPassportFields(passport);
  if (missing.length !== 0) {
    throw new IncompletePassportError(missing);
  }
  return passport as CompletePassport;
}

export class IncompletePassportError extends Error {
  public readonly code = 'PASSPORT_INCOMPLETE' as const;

  public constructor(public readonly missingFields: readonly string[]) {
    super(`Passport is incomplete: ${missingFields.join(', ')}`);
    this.name = 'IncompletePassportError';
  }
}

export function hashPassport(instrument: InstrumentHashFields, passport: CompletePassport): string {
  const canonical = canonicalizeJson({
    instrumentId: instrument.id,
    version: instrument.version.toString(),
    instrument: {
      type: instrument.type,
      legalNature: instrument.legalNature,
      currency: instrument.currency,
      unit: instrument.unit,
      unitPerToken: instrument.unitPerToken.toString(),
      supplyCap: instrument.supplyCap.toString(),
    },
    passport: passportToJson(passport),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function passportToJson(passport: PassportDraft): Readonly<Record<string, unknown>> {
  return {
    ...(passport.underlyingAsset === undefined
      ? {}
      : { underlyingAsset: { ...passport.underlyingAsset } }),
    ...(passport.holderRights === undefined
      ? {}
      : {
          holderRights: {
            ...passport.holderRights,
            redemptionMethods: [...passport.holderRights.redemptionMethods],
            transferRestrictions: [...passport.holderRights.transferRestrictions],
          },
        }),
    ...(passport.custodyAndVerification === undefined
      ? {}
      : {
          custodyAndVerification: {
            custodianId: passport.custodyAndVerification.custodianId,
            registryId: passport.custodyAndVerification.registryId,
            verifierIds: [...passport.custodyAndVerification.verifierIds],
            ...(passport.custodyAndVerification.evidenceRequirements === undefined
              ? {}
              : {
                  evidenceRequirements: [...passport.custodyAndVerification.evidenceRequirements],
                }),
          },
        }),
    ...(passport.economics === undefined
      ? {}
      : {
          economics: {
            issuePrice: passport.economics.issuePrice.toString(),
            issueCurrency: passport.economics.issueCurrency,
            maturityDate: passport.economics.maturityDate,
            feeSchedule: passport.economics.feeSchedule.map((fee) => ({
              feeType: fee.feeType,
              amount: fee.amount.toString(),
              currency: fee.currency,
            })),
          },
        }),
    ...(passport.tradingParameters === undefined
      ? {}
      : {
          tradingParameters: {
            tickSize: passport.tradingParameters.tickSize.toString(),
            lotSize: passport.tradingParameters.lotSize.toString(),
            minimumOrderQuantity: passport.tradingParameters.minimumOrderQuantity.toString(),
            minimumDeliveryQuantity: passport.tradingParameters.minimumDeliveryQuantity.toString(),
            settlementCycle: passport.tradingParameters.settlementCycle,
          },
        }),
    ...(passport.extensions === undefined ? {} : { extensions: passport.extensions }),
  };
}

export function passportFromJson(value: unknown): PassportDraft {
  const parsed = parsePassportDraft(value);
  if (parsed === null) {
    throw new TypeError('Persisted passport does not match TokenPassportDraft');
  }
  return parsed;
}

export function parsePassportDraft(value: unknown): PassportDraft | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'underlyingAsset',
      'holderRights',
      'custodyAndVerification',
      'economics',
      'tradingParameters',
      'extensions',
    ])
  ) {
    return null;
  }
  const underlyingAsset = parseUnderlying(value['underlyingAsset']);
  const holderRights = parseHolderRights(value['holderRights']);
  const custody = parseCustody(value['custodyAndVerification']);
  const economics = parseEconomics(value['economics']);
  const trading = parseTrading(value['tradingParameters']);
  const extensions = value['extensions'];
  if (
    underlyingAsset === null ||
    holderRights === null ||
    custody === null ||
    economics === null ||
    trading === null ||
    (extensions !== undefined && !isRecord(extensions))
  ) {
    return null;
  }
  return {
    ...(underlyingAsset === undefined ? {} : { underlyingAsset }),
    ...(holderRights === undefined ? {} : { holderRights }),
    ...(custody === undefined ? {} : { custodyAndVerification: custody }),
    ...(economics === undefined ? {} : { economics }),
    ...(trading === undefined ? {} : { tradingParameters: trading }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function parseUnderlying(value: unknown): UnderlyingAssetPassport | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'assetClass',
      'commodity',
      'grade',
      'originCountry',
      'unit',
      'storageLocation',
      'qualityStandard',
    ]) ||
    !stringsPresent(value, [
      'assetClass',
      'commodity',
      'grade',
      'originCountry',
      'unit',
      'storageLocation',
    ]) ||
    (value['qualityStandard'] !== undefined && !isNonBlankString(value['qualityStandard']))
  ) {
    return null;
  }
  return {
    assetClass: value['assetClass'] as string,
    commodity: value['commodity'] as string,
    grade: value['grade'] as string,
    originCountry: value['originCountry'] as string,
    unit: value['unit'] as string,
    storageLocation: value['storageLocation'] as string,
    ...(value['qualityStandard'] === undefined
      ? {}
      : { qualityStandard: value['qualityStandard'] }),
  };
}

function parseHolderRights(value: unknown): HolderRightsPassport | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'legalTitle',
      'claimDescription',
      'governingLaw',
      'redemptionMethods',
      'transferRestrictions',
    ]) ||
    !stringsPresent(value, ['legalTitle', 'claimDescription', 'governingLaw']) ||
    !isLegalNature(value['legalTitle']) ||
    !isStringArray(value['redemptionMethods'], true) ||
    !value['redemptionMethods'].every(isRedemptionMethod) ||
    !isStringArray(value['transferRestrictions'], false)
  ) {
    return null;
  }
  return {
    legalTitle: value['legalTitle'],
    claimDescription: value['claimDescription'] as string,
    governingLaw: value['governingLaw'] as string,
    redemptionMethods: value['redemptionMethods'],
    transferRestrictions: value['transferRestrictions'],
  };
}

function parseCustody(value: unknown): CustodyAndVerificationPassport | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['custodianId', 'registryId', 'verifierIds', 'evidenceRequirements']) ||
    !stringsPresent(value, ['custodianId', 'registryId']) ||
    !isStringArray(value['verifierIds'], true) ||
    (value['evidenceRequirements'] !== undefined &&
      !isStringArray(value['evidenceRequirements'], false))
  ) {
    return null;
  }
  return {
    custodianId: value['custodianId'] as string,
    registryId: value['registryId'] as string,
    verifierIds: value['verifierIds'],
    ...(value['evidenceRequirements'] === undefined
      ? {}
      : { evidenceRequirements: value['evidenceRequirements'] }),
  };
}

function parseEconomics(value: unknown): InstrumentEconomicsPassport | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['issuePrice', 'issueCurrency', 'maturityDate', 'feeSchedule']) ||
    !isPositiveIntegerString(value['issuePrice']) ||
    !isNonBlankString(value['issueCurrency']) ||
    !isNonBlankString(value['maturityDate']) ||
    !Array.isArray(value['feeSchedule'])
  ) {
    return null;
  }
  const fees = value['feeSchedule'].map(parseFee);
  if (fees.some((fee) => fee === null)) return null;
  return {
    issuePrice: BigInt(value['issuePrice']),
    issueCurrency: value['issueCurrency'] as string,
    maturityDate: value['maturityDate'] as string,
    feeSchedule: fees as PassportFee[],
  };
}

function parseFee(value: unknown): PassportFee | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['feeType', 'amount', 'currency']) ||
    !stringsPresent(value, ['feeType', 'currency']) ||
    !isNonNegativeIntegerString(value['amount'])
  ) {
    return null;
  }
  return {
    feeType: value['feeType'] as string,
    amount: BigInt(value['amount']),
    currency: value['currency'] as string,
  };
}

function parseTrading(value: unknown): TradingParametersPassport | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'tickSize',
      'lotSize',
      'minimumOrderQuantity',
      'minimumDeliveryQuantity',
      'settlementCycle',
    ]) ||
    !isPositiveIntegerString(value['tickSize']) ||
    !isPositiveIntegerString(value['lotSize']) ||
    !isPositiveIntegerString(value['minimumOrderQuantity']) ||
    !isPositiveIntegerString(value['minimumDeliveryQuantity']) ||
    !isSettlementCycle(value['settlementCycle'])
  ) {
    return null;
  }
  return {
    tickSize: BigInt(value['tickSize']),
    lotSize: BigInt(value['lotSize']),
    minimumOrderQuantity: BigInt(value['minimumOrderQuantity']),
    minimumDeliveryQuantity: BigInt(value['minimumDeliveryQuantity']),
    settlementCycle: value['settlementCycle'],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function stringsPresent(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => isNonBlankString(record[key]));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown, nonEmpty: boolean): value is string[] {
  return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every(isNonBlankString);
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/u.test(value);
}

function isNonNegativeIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value);
}

function isLegalNature(value: unknown): value is LegalNature {
  return (
    typeof value === 'string' &&
    [
      'CLAIM_RIGHT',
      'OWNERSHIP',
      'INCOME_SHARE',
      'LICENSE',
      'ACCESS',
      'DIGITAL_GOOD',
      'INVESTMENT',
    ].includes(value)
  );
}

function isRedemptionMethod(
  value: string,
): value is 'PHYSICAL_DELIVERY' | 'CASH' | 'DIGITAL_ACTIVATION' {
  return ['PHYSICAL_DELIVERY', 'CASH', 'DIGITAL_ACTIVATION'].includes(value);
}

function isSettlementCycle(value: unknown): value is 'T_PLUS_0' | 'T_PLUS_1' | 'T_PLUS_2' {
  return typeof value === 'string' && ['T_PLUS_0', 'T_PLUS_1', 'T_PLUS_2'].includes(value);
}

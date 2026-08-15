import type { components } from '../../../api/generated/schema.js';
import type {
  InstrumentDraftCreate,
  InstrumentDraftUpdate,
  IssuerInstrument,
} from '../api/issuerApi.js';

type LegalNature = components['schemas']['InstrumentLegalNature'];
export type WizardDocument = components['schemas']['AssetDocumentMetadata'];

export interface WizardModel {
  assetClass: string;
  commodity: string;
  grade: string;
  originCountry: string;
  unit: string;
  storageLocation: string;
  qualityStandard: string;
  assetQuantity: string;
  documents: WizardDocument[];
  legalNature: LegalNature;
  unitPerToken: string;
  claimDescription: string;
  nonOwnershipDisclosure: string;
  governingLaw: string;
  custodianId: string;
  registryId: string;
  verifierIds: string;
  issuePrice: string;
  currency: string;
  initialSupply: string;
  reservePercent: string;
  storageFee: string;
  maturityDate: string;
  tickSize: string;
  lotSize: string;
  minimumOrderQuantity: string;
  minimumDeliveryQuantity: string;
  ticker: string;
}

export const initialWizardModel: WizardModel = {
  assetClass: 'PHYSICAL_GOOD',
  commodity: '',
  grade: '',
  originCountry: 'KZ',
  unit: 'MT',
  storageLocation: '',
  qualityStandard: '',
  assetQuantity: '',
  documents: [],
  legalNature: 'CLAIM_RIGHT',
  unitPerToken: '1',
  claimDescription: '',
  nonOwnershipDisclosure: 'Токен не является правом собственности на элеватор или эмитента.',
  governingLaw: 'AIFC Law',
  custodianId: '',
  registryId: '',
  verifierIds: '',
  issuePrice: '',
  currency: 'KZT',
  initialSupply: '',
  reservePercent: '1',
  storageFee: '0',
  maturityDate: '',
  tickSize: '1',
  lotSize: '1',
  minimumOrderQuantity: '1',
  minimumDeliveryQuantity: '',
  ticker: '',
};

const positive = (value: string) => /^[1-9][0-9]*$/u.test(value);
const nonNegative = (value: string) => /^(0|[1-9][0-9]*)$/u.test(value);

export function validateStep(model: WizardModel, step: number): readonly string[] {
  const missing: string[] = [];
  const required = (value: string, label: string) => {
    if (value.trim().length === 0) missing.push(label);
  };
  if (step === 1) {
    required(model.commodity, 'Название товара');
    required(model.grade, 'Класс качества');
    required(model.storageLocation, 'Место хранения');
    if (!positive(model.assetQuantity))
      missing.push('Объём актива должен быть положительным целым числом');
  } else if (step === 2) {
    required(model.claimDescription, 'Описание права держателя');
    required(model.nonOwnershipDisclosure, 'Раскрытие ограничений права');
    if (!positive(model.unitPerToken))
      missing.push('Количество актива на токен должно быть положительным целым');
  } else if (step === 3) {
    required(model.custodianId, 'Хранитель');
    required(model.registryId, 'Реестр');
    required(model.verifierIds, 'Верификаторы');
  } else if (step === 4) {
    if (!positive(model.issuePrice))
      missing.push('Цена выпуска должна быть положительным целым числом');
    if (!positive(model.initialSupply))
      missing.push('Начальный выпуск должен быть положительным целым числом');
    if (!nonNegative(model.reservePercent))
      missing.push('Резерв должен быть целым неотрицательным процентом');
    if (!nonNegative(model.storageFee))
      missing.push('Плата за хранение должна быть целым неотрицательным значением');
    required(model.maturityDate, 'Срок погашения');
  } else if (step === 5) {
    required(model.ticker, 'Тикер');
    if (
      !positive(model.tickSize) ||
      !positive(model.lotSize) ||
      !positive(model.minimumOrderQuantity) ||
      !positive(model.minimumDeliveryQuantity)
    )
      missing.push('Торговые размеры должны быть положительными целыми числами');
  }
  return missing;
}

export function completedSteps(model: WizardModel): readonly boolean[] {
  return [1, 2, 3, 4, 5].map((step) => validateStep(model, step).length === 0);
}

export function readinessPercent(model: WizardModel): bigint {
  const completed = completedSteps(model).filter(Boolean).length;
  return (BigInt(completed) * 100n) / 5n;
}

export function buildDraft(model: WizardModel): InstrumentDraftCreate {
  const passport: InstrumentDraftCreate['passport'] = {};
  if (validateStep(model, 1).length === 0)
    passport.underlyingAsset = {
      assetClass: model.assetClass,
      commodity: model.commodity,
      grade: model.grade,
      originCountry: model.originCountry,
      unit: model.unit,
      storageLocation: model.storageLocation,
      quantity: model.assetQuantity,
      documents: model.documents,
      ...(model.qualityStandard.trim().length === 0
        ? {}
        : { qualityStandard: model.qualityStandard }),
    };
  if (validateStep(model, 2).length === 0)
    passport.holderRights = {
      legalTitle: model.legalNature,
      claimDescription: `${model.claimDescription}\n${model.nonOwnershipDisclosure}`,
      governingLaw: model.governingLaw,
      redemptionMethods: ['PHYSICAL_DELIVERY'],
      transferRestrictions: [model.nonOwnershipDisclosure],
    };
  if (validateStep(model, 3).length === 0)
    passport.custodyAndVerification = {
      custodianId: model.custodianId,
      registryId: model.registryId,
      verifierIds: model.verifierIds
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    };
  if (validateStep(model, 4).length === 0)
    passport.economics = {
      issuePrice: model.issuePrice,
      issueCurrency: model.currency,
      maturityDate: model.maturityDate,
      collateralReserveBps: (BigInt(model.reservePercent) * 100n).toString(),
      feeSchedule: [{ feeType: 'STORAGE', amount: model.storageFee, currency: model.currency }],
    };
  if (validateStep(model, 5).length === 0)
    passport.tradingParameters = {
      tickSize: model.tickSize,
      lotSize: model.lotSize,
      minimumOrderQuantity: model.minimumOrderQuantity,
      minimumDeliveryQuantity: model.minimumDeliveryQuantity,
      settlementCycle: 'T_PLUS_0',
    };
  return {
    type: 'COMMODITY_CLAIM',
    legalNature: model.legalNature,
    currency: model.currency,
    unit: model.unit,
    unitPerToken: model.unitPerToken,
    supplyCap: positive(model.initialSupply) ? model.initialSupply : model.assetQuantity,
    passport,
    extensions: { ticker: model.ticker || undefined },
  };
}

export function buildDraftUpdate(model: WizardModel, version: number): InstrumentDraftUpdate {
  return { ...buildDraft(model), version };
}

export function modelFromIssue(issue: IssuerInstrument): WizardModel {
  const asset = issue.passport.underlyingAsset;
  const rights = issue.passport.holderRights;
  const custody = issue.passport.custodyAndVerification;
  const economics = issue.passport.economics;
  const trading = issue.passport.tradingParameters;
  const ticker = issue.instrument.extensions?.['ticker'];
  const storage = economics?.feeSchedule.find((fee) => fee.feeType === 'STORAGE');
  return {
    ...initialWizardModel,
    assetClass: asset?.assetClass ?? initialWizardModel.assetClass,
    commodity: asset?.commodity ?? '',
    grade: asset?.grade ?? '',
    originCountry: asset?.originCountry ?? 'KZ',
    unit: asset?.unit ?? issue.instrument.unit,
    storageLocation: asset?.storageLocation ?? '',
    qualityStandard: asset?.qualityStandard ?? '',
    assetQuantity: asset?.quantity ?? issue.instrument.supplyCap,
    documents: asset?.documents ?? [],
    legalNature: issue.instrument.legalNature,
    unitPerToken: issue.instrument.unitPerToken,
    claimDescription: rights?.claimDescription.split('\n')[0] ?? '',
    nonOwnershipDisclosure:
      rights?.transferRestrictions[0] ?? initialWizardModel.nonOwnershipDisclosure,
    governingLaw: rights?.governingLaw ?? initialWizardModel.governingLaw,
    custodianId: custody?.custodianId ?? '',
    registryId: custody?.registryId ?? '',
    verifierIds: custody?.verifierIds.join(', ') ?? '',
    issuePrice: economics?.issuePrice ?? '',
    currency: issue.instrument.currency,
    initialSupply: issue.instrument.supplyCap,
    reservePercent:
      economics?.collateralReserveBps === undefined
        ? '1'
        : (BigInt(economics.collateralReserveBps) / 100n).toString(),
    storageFee: storage?.amount ?? '0',
    maturityDate: economics?.maturityDate ?? '',
    tickSize: trading?.tickSize ?? '1',
    lotSize: trading?.lotSize ?? '1',
    minimumOrderQuantity: trading?.minimumOrderQuantity ?? '1',
    minimumDeliveryQuantity: trading?.minimumDeliveryQuantity ?? '',
    ticker: typeof ticker === 'string' ? ticker : '',
  };
}

export const missingFieldStep: Readonly<Record<string, number>> = {
  'passport.underlyingAsset': 1,
  'passport.holderRights': 2,
  'passport.custodyAndVerification': 3,
  'passport.economics': 4,
  'passport.tradingParameters': 5,
};

import { describe, expect, it } from 'vitest';

import {
  assertCompletePassport,
  hashPassport,
  missingPassportFields,
  parsePassportDraft,
} from './instrument-passport.js';

describe('instrument passport', () => {
  it('returns every missing passport section in deterministic order', () => {
    expect(missingPassportFields({})).toEqual([
      'passport.underlyingAsset',
      'passport.holderRights',
      'passport.custodyAndVerification',
      'passport.economics',
      'passport.tradingParameters',
    ]);
    expect(() => assertCompletePassport({})).toThrowError(/passport\.underlyingAsset/u);
  });

  it('hashes canonical content deterministically and binds the version', () => {
    const passport = assertCompletePassport(parsePassportDraft(completePassportJson())!);
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'GRAIN_TOKEN',
      legalNature: 'CLAIM_RIGHT' as const,
      currency: 'KZT',
      unit: 'GRAM',
      unitPerToken: 1_000n,
      supplyCap: 10_000n,
    };
    const first = hashPassport({ ...base, version: 1n }, passport);
    const same = hashPassport({ ...base, version: 1n }, passport);
    const revised = hashPassport({ ...base, version: 2n }, passport);

    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(same).toBe(first);
    expect(revised).not.toBe(first);
  });

  it('rejects number values at the transport boundary for monetary fields', () => {
    const json = completePassportJson();
    const economics = json['economics'] as Record<string, unknown>;
    economics['issuePrice'] = 100;
    expect(parsePassportDraft(json)).toBeNull();
  });
});

function completePassportJson(): Record<string, unknown> {
  return {
    underlyingAsset: {
      assetClass: 'GRAIN',
      commodity: 'Wheat',
      grade: 'Class 3',
      originCountry: 'KZ',
      unit: 'GRAM',
      storageLocation: 'Elevator A',
    },
    holderRights: {
      legalTitle: 'CLAIM_RIGHT',
      claimDescription: 'Claim for grain delivery',
      governingLaw: 'AIFC law',
      redemptionMethods: ['PHYSICAL_DELIVERY'],
      transferRestrictions: [],
    },
    custodyAndVerification: {
      custodianId: 'custodian-1',
      registryId: 'ezr-registry',
      verifierIds: ['verifier-1'],
    },
    economics: {
      issuePrice: '10000',
      issueCurrency: 'KZT',
      maturityDate: '2027-08-14',
      feeSchedule: [{ feeType: 'REDEMPTION', amount: '100', currency: 'KZT' }],
    },
    tradingParameters: {
      tickSize: '1',
      lotSize: '1',
      minimumOrderQuantity: '1',
      minimumDeliveryQuantity: '1',
      settlementCycle: 'T_PLUS_1',
    },
  };
}

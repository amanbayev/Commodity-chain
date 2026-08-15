// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../api/errors.js';
import type { InstrumentDraft, IssuerInstrument } from '../api/issuerApi.js';
import { CreateTokenPage } from './CreateTokenPage.js';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  submit: vi.fn(),
  existing: vi.fn(),
}));

vi.mock('../api/queries.js', () => ({
  useDraftCommands: () => ({
    create: { isPending: false, mutateAsync: mocks.create },
    update: { isPending: false, mutateAsync: mocks.update },
    submit: { isPending: false, mutateAsync: mocks.submit },
  }),
  useIssuerInstrument: () => mocks.existing(),
}));

const instrument = {
  circulatingSupply: '0',
  createdAt: '2026-08-15T00:00:00Z',
  currency: 'KZT',
  extensions: { ticker: 'WHT-3-2026' },
  id: '11111111-1111-4111-8111-111111111111',
  legalNature: 'CLAIM_RIGHT' as const,
  status: 'DRAFT' as const,
  supplyCap: '5000',
  type: 'COMMODITY_CLAIM',
  unit: 'MT',
  unitPerToken: '1',
  updatedAt: '2026-08-15T00:00:00Z',
  version: 1,
};

const created: InstrumentDraft = { instrument, passport: {}, version: 1 };
const completeIssue: IssuerInstrument = {
  collateralPositions: [],
  instrument,
  version: 1,
  verifiedAvailable: '0',
  passport: {
    underlyingAsset: {
      assetClass: 'PHYSICAL_GOOD',
      commodity: 'Пшеница',
      grade: '3 класс',
      originCountry: 'KZ',
      quantity: '5000',
      storageLocation: 'Астана Агро',
      unit: 'MT',
    },
    holderRights: {
      claimDescription: 'Право требования',
      governingLaw: 'AIFC Law',
      legalTitle: 'CLAIM_RIGHT',
      redemptionMethods: ['PHYSICAL_DELIVERY'],
      transferRestrictions: ['Не является правом собственности'],
    },
    custodyAndVerification: {
      custodianId: 'astana-agro',
      registryId: 'ezr-kz',
      verifierIds: ['quality-lab'],
    },
    economics: {
      collateralReserveBps: '100',
      feeSchedule: [{ amount: '0', currency: 'KZT', feeType: 'STORAGE' }],
      issueCurrency: 'KZT',
      issuePrice: '124000',
      maturityDate: '2027-06-30',
    },
    tradingParameters: {
      lotSize: '1',
      minimumDeliveryQuantity: '20',
      minimumOrderQuantity: '1',
      settlementCycle: 'T_PLUS_0',
      tickSize: '100',
    },
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.existing.mockReturnValue({ data: undefined });
});

describe('CreateTokenPage', () => {
  it('validates step one and creates the server draft before advancing', async () => {
    mocks.existing.mockReturnValue({ data: undefined });
    mocks.create.mockResolvedValue(created);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateTokenPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Сохранить и продолжить' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Название товара');
    expect(mocks.create).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: 'Название товара' }), 'Пшеница');
    await user.type(screen.getByRole('textbox', { name: 'Класс качества' }), '3 класс');
    await user.type(screen.getByRole('textbox', { name: 'Объём актива' }), '5000');
    await user.type(screen.getByRole('textbox', { name: 'Место хранения' }), 'Астана Агро');
    await user.click(screen.getByRole('button', { name: 'Сохранить и продолжить' }));
    expect(await screen.findByRole('heading', { name: 'Права держателя' })).toBeInTheDocument();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({ supplyCap: '5000', unitPerToken: '1' });
  });

  it('returns to the API-reported incomplete section after submit', async () => {
    mocks.existing.mockReturnValue({ data: completeIssue });
    mocks.submit.mockRejectedValue(
      new ApiError(
        {
          code: 'PASSPORT_INCOMPLETE',
          correlationId: 'correlation-1',
          message: 'incomplete',
          details: [{ field: 'passport.economics', reason: 'Required for listing submit' }],
        },
        422,
      ),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/create-token?id=${instrument.id}`]}>
        <CreateTokenPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('WHT-3-2026')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /6Проверка/u }));
    await user.click(screen.getByRole('button', { name: 'Подписать ЭЦП и отправить на листинг' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('будет подключена позже');
    await user.click(screen.getByRole('button', { name: 'Подписать и отправить' }));
    expect(await screen.findByRole('heading', { name: 'Экономика выпуска' })).toBeInTheDocument();
    expect(screen.getByText(/passport\.economics/u)).toBeInTheDocument();
  });
});

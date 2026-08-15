// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstrumentMarketItem } from '../api/investorApi.js';
import { MarketTable } from './MarketTable.js';

const instrument: InstrumentMarketItem = {
  availableSupply: '2450',
  instrument: {
    circulatingSupply: '85230',
    createdAt: '2026-08-15T00:00:00Z',
    currency: 'KZT',
    id: '11111111-1111-4111-8111-111111111111',
    legalNature: 'CLAIM_RIGHT',
    status: 'ACTIVE',
    supplyCap: '100000',
    type: 'COMMODITY_CLAIM',
    unit: 'MT',
    unitPerToken: '1',
    updatedAt: '2026-08-15T00:00:00Z',
    version: 3,
  },
  lastTradePrice: '125400',
  name: 'Пшеница 3 класса',
  priceChangeBps: '180',
  ticker: 'WHT-3',
  tradingVolume24h: '1560000000',
};

afterEach(cleanup);

describe('MarketTable', () => {
  it('renders API values and opens the selected instrument', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/market']}>
        <Routes>
          <Route element={<MarketTable instruments={[instrument]} />} path="/market" />
          <Route element={<p>Карточка инструмента</p>} path="/market/:instrumentId" />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Пшеница 3 класса')).toBeInTheDocument();
    expect(screen.getByText('125 400 ₸')).toBeInTheDocument();
    expect(screen.getByText('+1,8%')).toBeInTheDocument();
    await user.click(screen.getByRole('row', { name: /Пшеница 3 класса/u }));
    expect(screen.getByText('Карточка инструмента')).toBeInTheDocument();
  });
});

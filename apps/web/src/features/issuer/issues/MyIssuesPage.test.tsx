// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import type { IssuerInstrumentSummary } from '../api/issuerApi.js';
import { IssuesTable } from './MyIssuesPage.js';

const base = {
  circulatingSupply: '0',
  createdAt: '2026-08-15T00:00:00Z',
  currency: 'KZT',
  legalNature: 'CLAIM_RIGHT' as const,
  supplyCap: '5000',
  type: 'COMMODITY_CLAIM',
  unit: 'MT',
  unitPerToken: '1',
  updatedAt: '2026-08-15T00:00:00Z',
  version: 1,
};

const issues: IssuerInstrumentSummary[] = [
  {
    instrument: {
      ...base,
      extensions: { ticker: 'WHT-DRAFT' },
      id: '11111111-1111-4111-8111-111111111111',
      status: 'DRAFT',
    },
    passport: {},
    verifiedAvailable: '0',
    version: 1,
  },
  {
    instrument: {
      ...base,
      extensions: { ticker: 'WHT-ACTIVE' },
      id: '22222222-2222-4222-8222-222222222222',
      status: 'ACTIVE',
    },
    passport: {},
    verifiedAvailable: '5000',
    version: 2,
  },
];

afterEach(cleanup);

describe('IssuesTable', () => {
  it('renders issuer statuses and offers draft continuation only for drafts', () => {
    render(
      <MemoryRouter>
        <IssuesTable issues={issues} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Черновик')).toBeInTheDocument();
    expect(screen.getByText('Активен')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Продолжить черновик' })).toHaveLength(1);
  });
});

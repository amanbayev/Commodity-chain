// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App.js';
import { AppProviders } from '../app/AppProviders.js';

afterEach(cleanup);

describe('application layout', () => {
  it('renders navigation, role switcher, and routed content', () => {
    render(
      <MemoryRouter initialEntries={['/market']}>
        <AppProviders>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(screen.getByRole('navigation', { name: 'Основная навигация' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Роль' })).toHaveValue('investor');
    expect(screen.getByRole('heading', { level: 1, name: 'Рынок' })).toBeInTheDocument();
    expect(screen.getByText('Кабинет инвестора')).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatusBadge } from './StatusBadge.js';

afterEach(cleanup);

describe('StatusBadge', () => {
  it.each([
    ['ACTIVE', 'Активен'],
    ['PARTIALLY_FILLED', 'Частично исполнена'],
    ['QUARANTINED', 'Карантин'],
  ] as const)('renders contract status %s', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toHaveAttribute('data-status', status);
  });
});

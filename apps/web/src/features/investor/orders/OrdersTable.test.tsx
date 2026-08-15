// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Order } from '../api/investorApi.js';
import { OrdersTable } from './OrdersTable.js';

const order: Order = {
  clientOrderId: 'client-1',
  createdAt: '2026-08-15T00:00:00Z',
  feeScheduleVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  instrumentId: '22222222-2222-4222-8222-222222222222',
  openQuantity: '60',
  price: '125400',
  quantity: '100',
  side: 'BUY',
  status: 'PARTIALLY_FILLED',
  trades: [],
  type: 'LIMIT',
  updatedAt: '2026-08-15T00:00:00Z',
};

afterEach(cleanup);

describe('OrdersTable', () => {
  it('confirms cancellation of the open remainder', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn().mockResolvedValue(undefined);
    render(<OrdersTable instruments={[]} onCancel={cancel} orders={[order]} />);
    expect(screen.getByText('40')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Отменить заявку ${order.id}` }));
    expect(screen.getByRole('dialog')).toHaveTextContent('60 токенов');
    await user.click(screen.getByRole('button', { name: 'Подтвердить отмену' }));
    expect(cancel).toHaveBeenCalledWith(order.id);
  });
});

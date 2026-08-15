// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../api/errors.js';
import type { Order } from '../api/investorApi.js';
import { OrderTicket } from './OrderTicket.js';

const acceptedOrder: Order = {
  clientOrderId: 'client-1',
  createdAt: '2026-08-15T00:00:00Z',
  feeScheduleVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  instrumentId: '22222222-2222-4222-8222-222222222222',
  openQuantity: '20',
  price: '125400',
  quantity: '20',
  side: 'BUY',
  status: 'OPEN',
  trades: [],
  type: 'LIMIT',
  updatedAt: '2026-08-15T00:00:00Z',
};

afterEach(cleanup);

function renderTicket(onSubmit = vi.fn().mockResolvedValue(acceptedOrder)) {
  render(
    <OrderTicket
      currency="KZT"
      initialPrice="125400"
      instrumentId={acceptedOrder.instrumentId}
      lotSize="20"
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe('OrderTicket', () => {
  it('requires risk acknowledgement before submission', async () => {
    const user = userEvent.setup();
    const submit = renderTicket();
    await user.click(screen.getByRole('button', { name: 'Купить токены' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Подтвердите ознакомление');
    expect(submit).not.toHaveBeenCalled();
  });

  it('validates positive integer quantity and lot size', async () => {
    const user = userEvent.setup();
    const submit = renderTicket();
    const quantity = screen.getByRole('textbox', { name: 'Количество' });
    await user.clear(quantity);
    await user.type(quantity, '21');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Купить токены' }));
    expect(screen.getByRole('alert')).toHaveTextContent('кратно размеру лота 20');
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows the deterministic insufficient-funds error', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(
      new ApiError(
        {
          code: 'INSUFFICIENT_FUNDS',
          correlationId: 'correlation-1',
          details: [],
          message: 'insufficient',
        },
        422,
      ),
    );
    renderTicket(submit);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Купить токены' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Недостаточно доступных средств или токенов.',
    );
    expect(submit).toHaveBeenCalledOnce();
  });
});

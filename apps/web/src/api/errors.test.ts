// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client.js';
import { ApiError, getUserErrorMessage } from './errors.js';

const responseBody = {
  code: 'INSUFFICIENT_FUNDS' as const,
  correlationId: '11111111-1111-4111-8111-111111111111',
  details: [{ field: 'quantity', reason: 'Available balance is insufficient' }],
  message: 'Insufficient funds',
};

describe('API error handling', () => {
  it('maps a deterministic contract code to a user-facing message', () => {
    const error = new ApiError(responseBody, 422);
    expect(getUserErrorMessage(error)).toBe('Недостаточно доступных средств или токенов.');
    expect(error.correlationId).toBe(responseBody.correlationId);
  });

  it('preserves the API error and reports its correlation id', async () => {
    const onError = vi.fn();
    const fetchImplementation = vi.fn(
      async () =>
        new Response(JSON.stringify(responseBody), {
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': responseBody.correlationId,
          },
          status: 422,
        }),
    );
    const client = createApiClient({ fetchImplementation, onError });

    await expect(
      client.request<never, '/orders', 'post', { quantity: string }>({
        body: { quantity: '10' },
        correlationId: responseBody.correlationId,
        idempotencyKey: 'order-1',
        method: 'POST',
        path: '/orders',
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      correlationId: responseBody.correlationId,
    });
    expect(onError).toHaveBeenCalledOnce();
  });
});

import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { createApiClient } from './client.js';
import { getUserErrorMessage } from './errors.js';

export function useApi() {
  const { session } = useAuth();

  return useMemo(
    () =>
      createApiClient({
        getAccessToken: () => session.accessToken,
        onError: (error) => {
          console.error(`[Commodity Chain API] ${getUserErrorMessage(error)}`, {
            code: error.code,
            correlationId: error.correlationId,
          });
        },
      }),
    [session.accessToken],
  );
}

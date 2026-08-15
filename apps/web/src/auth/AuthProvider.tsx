import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { AuthProviderContract, AuthRole, AuthSession } from './auth.types.js';

const roleParticipants: Record<AuthRole, Pick<AuthSession, 'displayName' | 'participantId'>> = {
  elevator: {
    displayName: 'Элеватор Астана Агро',
    participantId: '44444444-4444-4444-8444-444444444444',
  },
  investor: { displayName: 'Иванов И. И.', participantId: '11111111-1111-4111-8111-111111111111' },
  issuer: {
    displayName: 'ТОО Grain Capital',
    participantId: '22222222-2222-4222-8222-222222222222',
  },
  operator: {
    displayName: 'Оператор листинга',
    participantId: '33333333-3333-4333-8333-333333333333',
  },
};

const AuthContext = createContext<AuthProviderContract | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialRole?: AuthRole;
}

export function AuthProvider({ children, initialRole = 'investor' }: AuthProviderProps) {
  const initialParticipant = roleParticipants[initialRole];
  const [session, setSession] = useState<AuthSession>({
    accessToken: null,
    displayName: initialParticipant.displayName,
    participantId: initialParticipant.participantId,
    role: initialRole,
  });

  const value = useMemo<AuthProviderContract>(
    () => ({
      session,
      setParticipantId: (participantId) => {
        setSession((current) => ({ ...current, participantId }));
      },
      setRole: (role) => {
        setSession({ accessToken: null, role, ...roleParticipants[role] });
      },
    }),
    [session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthProviderContract {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

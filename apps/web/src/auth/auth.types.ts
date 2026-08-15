export type AuthRole = 'elevator' | 'investor' | 'issuer' | 'operator';

export interface AuthSession {
  accessToken: string | null;
  displayName: string;
  participantId: string;
  role: AuthRole;
}

export interface AuthProviderContract {
  session: AuthSession;
  setParticipantId: (participantId: string) => void;
  setRole: (role: AuthRole) => void;
}

export const authRoleLabels: Record<AuthRole, string> = {
  elevator: 'Элеватор',
  investor: 'Инвестор',
  issuer: 'Эмитент',
  operator: 'Оператор',
};

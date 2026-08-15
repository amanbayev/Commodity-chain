import type { AuthRole } from '../auth/auth.types.js';
import type { IconName } from '../components/Icon.js';

export interface NavigationItem {
  icon: IconName;
  label: string;
  to: string;
}

const commonNavigation: readonly NavigationItem[] = [
  { icon: 'market', label: 'Рынок', to: '/market' },
  { icon: 'assets', label: 'Мои активы', to: '/assets' },
  { icon: 'create', label: 'Создать токен', to: '/create-token' },
  { icon: 'terminal', label: 'Торговый терминал', to: '/terminal' },
  { icon: 'redemption', label: 'Погашение', to: '/redemption' },
  { icon: 'documents', label: 'Документы', to: '/documents' },
];

const roleDashboardLabels: Record<AuthRole, string> = {
  elevator: 'Кабинет элеватора',
  investor: 'Кабинет инвестора',
  issuer: 'Кабинет эмитента',
  operator: 'Кабинет оператора',
};

export function navigationForRole(role: AuthRole): readonly NavigationItem[] {
  return [
    { icon: 'assets', label: roleDashboardLabels[role], to: `/cabinet/${role}` },
    ...commonNavigation,
  ];
}

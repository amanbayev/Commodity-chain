import { NavLink } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { Icon } from '../components/Icon.js';
import { navigationForRole } from './navigation.js';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  onNavigate: () => void;
  open: boolean;
}

export function Sidebar({ onNavigate, open }: SidebarProps) {
  const { session } = useAuth();
  const navigation = navigationForRole(session.role);

  return (
    <aside className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <div aria-hidden="true" className={styles.mark}>
          ◇
        </div>
        <div>
          <strong>COMMODITY</strong>
          <strong>CHAIN</strong>
          <small>AIFC Platform</small>
        </div>
      </div>
      <nav aria-label="Основная навигация" className={styles.nav}>
        {navigation.map((item) => (
          <NavLink
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
            key={item.to}
            onClick={onNavigate}
            to={item.to}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className={styles.footer}>
        <span className={styles.liveDot} />
        <span>Все системы работают</span>
      </div>
    </aside>
  );
}

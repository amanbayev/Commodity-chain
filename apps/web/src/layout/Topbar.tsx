import { authRoleLabels } from '../auth/auth.types.js';
import type { AuthRole } from '../auth/auth.types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Icon } from '../components/Icon.js';
import styles from './Topbar.module.css';

export interface TopbarProps {
  onMenu: () => void;
}

export function Topbar({ onMenu }: TopbarProps) {
  const { session, setParticipantId, setRole } = useAuth();

  return (
    <header className={styles.topbar}>
      <button aria-label="Открыть меню" className={styles.menu} onClick={onMenu} type="button">
        <Icon name="menu" />
      </button>
      <div className={styles.trust}>
        <span aria-hidden="true">✓</span> Регулируемая инфраструктура AIFC
      </div>
      <div className={styles.session}>
        <label>
          <span>Роль</span>
          <select
            aria-label="Роль"
            onChange={(event) => {
              setRole(event.target.value as AuthRole);
            }}
            value={session.role}
          >
            {Object.entries(authRoleLabels).map(([role, label]) => (
              <option key={role} value={role}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.participant}>
          <span>Participant ID</span>
          <input
            aria-label="Participant ID"
            onChange={(event) => {
              setParticipantId(event.target.value);
            }}
            value={session.participantId}
          />
        </label>
        <div className={styles.avatar}>{session.displayName.slice(0, 1)}</div>
      </div>
    </header>
  );
}

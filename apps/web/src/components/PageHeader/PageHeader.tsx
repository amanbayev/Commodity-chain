import type { ReactNode } from 'react';

import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  actions?: ReactNode;
  eyebrow?: string;
  subtitle?: string;
  title: string;
}

export function PageHeader({ actions, eyebrow, subtitle, title }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div>
        {eyebrow === undefined ? null : <div className={styles.eyebrow}>{eyebrow}</div>}
        <h1 className={styles.title}>{title}</h1>
        {subtitle === undefined ? null : <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

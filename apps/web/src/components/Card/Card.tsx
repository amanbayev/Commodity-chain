import type { HTMLAttributes, ReactNode } from 'react';

import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  title?: string;
}

export function Card({ children, className, title, ...props }: CardProps) {
  return (
    <section {...props} className={[styles.card, className].filter(Boolean).join(' ')}>
      {title === undefined ? null : <h2 className={styles.title}>{title}</h2>}
      <div className={styles.body}>{children}</div>
    </section>
  );
}

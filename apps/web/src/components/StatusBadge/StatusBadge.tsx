import type { components } from '../../api/generated/schema.js';

import styles from './StatusBadge.module.css';

type InstrumentStatus = components['schemas']['InstrumentStatus'];
type OrderStatus = components['schemas']['OrderStatus'];
type RedemptionStatus = components['schemas']['RedemptionStatus'];

export type PlatformStatus = InstrumentStatus | OrderStatus | RedemptionStatus;
type StatusTone = 'danger' | 'info' | 'neutral' | 'success' | 'violet' | 'warning';

const labels: Record<PlatformStatus, string> = {
  ACCEPTED: 'Принята',
  ACTIVE: 'Активен',
  APPROVED: 'Одобрен',
  CANCEL_PENDING: 'Отмена ожидается',
  CANCELLED: 'Отменена',
  CLOSED: 'Закрыт',
  COLLATERALIZED: 'Обеспечен',
  COMPLETED: 'Завершена',
  CREATED: 'Создана',
  DEFAULT: 'Дефолт',
  DRAFT: 'Черновик',
  EXCEPTION: 'Исключение',
  EXPIRED: 'Истекла',
  FILLED: 'Исполнена',
  IN_DELIVERY: 'В доставке',
  MATURED: 'Погашен',
  NEW: 'Новая',
  OPEN: 'Открыта',
  PARTIALLY_FILLED: 'Частично исполнена',
  PRIMARY: 'Первичное размещение',
  QUARANTINED: 'Карантин',
  REDEMPTION: 'Погашение',
  REJECTED: 'Отклонена',
  SUSPENDED: 'Приостановлен',
  TOKENS_LOCKED: 'Токены заблокированы',
  UNDER_REVIEW: 'На проверке',
  VALIDATING: 'Проверяется',
};

const tones: Record<PlatformStatus, StatusTone> = {
  ACCEPTED: 'info',
  ACTIVE: 'success',
  APPROVED: 'success',
  CANCEL_PENDING: 'warning',
  CANCELLED: 'neutral',
  CLOSED: 'neutral',
  COLLATERALIZED: 'success',
  COMPLETED: 'success',
  CREATED: 'neutral',
  DEFAULT: 'danger',
  DRAFT: 'neutral',
  EXCEPTION: 'danger',
  EXPIRED: 'neutral',
  FILLED: 'success',
  IN_DELIVERY: 'info',
  MATURED: 'success',
  NEW: 'neutral',
  OPEN: 'info',
  PARTIALLY_FILLED: 'warning',
  PRIMARY: 'violet',
  QUARANTINED: 'danger',
  REDEMPTION: 'warning',
  REJECTED: 'danger',
  SUSPENDED: 'warning',
  TOKENS_LOCKED: 'warning',
  UNDER_REVIEW: 'warning',
  VALIDATING: 'info',
};

export interface StatusBadgeProps {
  status: PlatformStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tones[status]]}`} data-status={status}>
      <span aria-hidden="true" className={styles.dot} />
      {labels[status]}
    </span>
  );
}

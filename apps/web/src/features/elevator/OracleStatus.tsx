import type { components } from '../../api/generated/schema.js';
import styles from './Elevator.module.css';

type Event = components['schemas']['ElevatorOracleEvent'];

export function OracleStatus({ event }: { event: Event }) {
  const tone =
    event.status === 'APPLIED'
      ? styles.success
      : event.status === 'QUARANTINED' || event.status === 'REJECTED'
        ? styles.danger
        : styles.warning;
  return (
    <div aria-label={`Статус события ${event.status}`}>
      <span className={`${styles.status} ${tone}`}>{event.status}</span>
      {event.failureCode === undefined ? null : <div>{event.failureCode}</div>}
      {event.failureDetails?.map((detail, index) => (
        <small key={`${detail.field}-${index}`}>
          {detail.field}: {detail.reason}
        </small>
      ))}
    </div>
  );
}

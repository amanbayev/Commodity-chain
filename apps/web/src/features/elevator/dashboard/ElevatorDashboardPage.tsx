import { useNavigate } from 'react-router-dom';
import type { components } from '../../../api/generated/schema.js';
import { Card } from '../../../components/Card/Card.js';
import { DataTable, type DataTableColumn } from '../../../components/DataTable/DataTable.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { formatInteger } from '../../../lib/integer-format.js';
import { useElevatorDashboard } from '../api/queries.js';
import { OracleStatus } from '../OracleStatus.js';
import styles from '../Elevator.module.css';

type Dashboard = components['schemas']['ElevatorDashboard'];
type Request = components['schemas']['ElevatorVerificationRequest'];

const columns: readonly DataTableColumn<Request>[] = [
  { id: 'request', header: 'Запрос', cell: (row) => row.requestId, value: (row) => row.requestId },
  { id: 'applicant', header: 'Компания', cell: (row) => row.applicant },
  { id: 'commodity', header: 'Товар', cell: (row) => row.commodity },
  {
    id: 'quantity',
    header: 'Количество',
    align: 'right',
    cell: (row) => `${formatInteger(row.quantity)} ${row.unit}`,
    value: (row) => row.quantity,
    sortable: true,
  },
  { id: 'status', header: 'Статус', cell: (row) => row.status },
];

export function ElevatorDashboardView({ dashboard }: { dashboard: Dashboard }) {
  const navigate = useNavigate();
  return (
    <div className={styles.page}>
      <div className={styles.metrics}>
        <Card>
          <div className={styles.metric}>
            <span>На проверке</span>
            <strong>{dashboard.onReview}</strong>
          </div>
        </Card>
        <Card>
          <div className={styles.metric}>
            <span>Зарезервировано</span>
            <strong>{formatInteger(dashboard.reservedQuantity)} т</strong>
          </div>
        </Card>
        <Card>
          <div className={styles.metric}>
            <span>Ожидают отгрузки</span>
            <strong>{dashboard.awaitingShipment}</strong>
          </div>
        </Card>
        <Card>
          <div className={styles.metric}>
            <span>Активные расписки</span>
            <strong>{dashboard.activeReceipts}</strong>
          </div>
        </Card>
      </div>
      <div className={styles.columns}>
        <div className={styles.stack}>
          <Card title="Входящие запросы на подтверждение">
            <DataTable
              columns={columns}
              data={dashboard.verificationRequests}
              getRowId={(row) => row.requestId}
              onRowClick={(row) => navigate(`/elevator/verify/${row.requestId}`)}
            />
          </Card>
          <Card title="Ближайшие отгрузки">
            {dashboard.shipments.length === 0 ? (
              <p>Нет заявок на отгрузку</p>
            ) : (
              dashboard.shipments.map(({ redemption, instrumentTicker, underlyingQuantity }) => (
                <button
                  key={redemption.id}
                  type="button"
                  onClick={() => navigate(`/elevator/shipments/${redemption.id}`)}
                >
                  {instrumentTicker} · {formatInteger(underlyingQuantity)} · {redemption.status}
                </button>
              ))
            )}
          </Card>
        </div>
        <div className={styles.stack}>
          {dashboard.incidents === undefined || dashboard.incidents.length === 0 ? null : (
            <Card title="Требуют внимания">
              {dashboard.incidents.map((incident) => (
                <div key={incident.id} className={styles.notice}>
                  {incident.eventType}: {incident.message ?? incident.aggregateId}
                </div>
              ))}
            </Card>
          )}
          <Card title="Последние подписанные события">
            {dashboard.recentEvents.length === 0 ? (
              <p>Событий пока нет</p>
            ) : (
              dashboard.recentEvents.map((event) => (
                <div key={event.envelope.eventId}>
                  <strong>{event.envelope.eventType}</strong> ·{' '}
                  {formatInteger(event.envelope.quantity)} {event.envelope.unit}
                  <OracleStatus event={event} />
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function ElevatorDashboardPage() {
  const query = useElevatorDashboard();
  return (
    <div className={styles.page}>
      <PageHeader
        title="Рабочая панель элеватора"
        subtitle="Расписи, резервирование и физическая отгрузка"
      />
      {query.isPending ? (
        <p>Загрузка…</p>
      ) : query.isError ? (
        <p>Не удалось загрузить кабинет.</p>
      ) : (
        <ElevatorDashboardView dashboard={query.data} />
      )}
    </div>
  );
}

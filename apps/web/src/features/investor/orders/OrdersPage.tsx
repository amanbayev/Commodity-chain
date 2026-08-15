import { getUserErrorMessage } from '../../../api/errors.js';
import { Card } from '../../../components/Card/Card.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { useCancelOrder, useMarketInstruments, useParticipantOrders } from '../api/queries.js';
import { OrdersTable } from './OrdersTable.js';
import styles from './OrdersPage.module.css';

export function OrdersPage() {
  const market = useMarketInstruments();
  const orders = useParticipantOrders();
  const cancel = useCancelOrder();
  const error = orders.error ?? cancel.error;

  return (
    <>
      <PageHeader
        eyebrow="Инвестор"
        subtitle="Открытые, исполненные и отменённые торговые заявки."
        title="Мои заявки"
      />
      <Card>
        {error === null ? null : (
          <p className={styles.error} role="alert">
            {getUserErrorMessage(error)}
          </p>
        )}
        <OrdersTable
          instruments={market.data?.items ?? []}
          onCancel={cancel.mutateAsync}
          orders={orders.data?.items ?? []}
        />
        {orders.isLoading ? <p className={styles.loading}>Загрузка заявок…</p> : null}
      </Card>
    </>
  );
}

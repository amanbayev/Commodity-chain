import { useParams } from 'react-router-dom';
import { Button } from '../../../components/Button/Button.js';
import { Card } from '../../../components/Card/Card.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { formatInteger } from '../../../lib/integer-format.js';
import { useConfirmShipment, useShipment } from '../api/queries.js';
import { OracleStatus } from '../OracleStatus.js';
import styles from '../Elevator.module.css';

export function ShipmentPage() {
  const { redemptionId = '' } = useParams();
  const query = useShipment(redemptionId);
  const confirm = useConfirmShipment(redemptionId);
  if (query.isPending) return <p>Загрузка…</p>;
  if (query.isError) return <p>Заявка на отгрузку не найдена.</p>;
  const { shipment, receipt, changes, eventPreview } = query.data;
  const order = confirm.data?.redemption ?? shipment.redemption;
  const submit = () => {
    if (globalThis.confirm('Подписание факта отгрузки ЭЦП (будет подключено)')) confirm.mutate();
  };
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={`Redemption ${redemptionId}`}
        title="Подтверждение отгрузки"
        subtitle={`${shipment.instrumentTicker} · ${order.status}`}
      />
      <div className={styles.steps}>
        {[
          'Заявка получена',
          'Товар зарезервирован',
          'Документы проверены',
          'Отгрузка',
          'Подтверждение и погашение',
        ].map((step, index) => (
          <div className={index < 4 ? styles.stepActive : styles.step} key={step}>
            {index + 1}. {step}
          </div>
        ))}
      </div>
      <div className={styles.columns}>
        <div className={styles.stack}>
          <Card title="Детали заявки">
            <dl className={styles.facts}>
              <div>
                <dt>Количество токенов</dt>
                <dd>{formatInteger(order.quantity)}</dd>
              </div>
              <div>
                <dt>Количество товара</dt>
                <dd>
                  {formatInteger(shipment.underlyingQuantity)} {receipt.unit}
                </dd>
              </div>
              <div>
                <dt>Получатель</dt>
                <dd>{order.delivery.recipient}</dd>
              </div>
              <div>
                <dt>Транспорт</dt>
                <dd>{order.delivery.transport}</dd>
              </div>
              <div>
                <dt>Дата</dt>
                <dd>{order.delivery.requestedDate}</dd>
              </div>
              <div>
                <dt>Расписка</dt>
                <dd>{receipt.receiptId}</dd>
              </div>
            </dl>
          </Card>
          <Card title="Предпросмотр события Oracle">
            <pre className={styles.preview}>{JSON.stringify(eventPreview, null, 2)}</pre>
          </Card>
        </div>
        <div className={styles.stack}>
          <Card title="Финальное подтверждение">
            {[
              'Транспортное средство проверено',
              'Получатель проверен',
              'Нетто-вес подтверждён',
              'Документы подписаны',
              'Выезд зафиксирован',
            ].map((label) => (
              <div className={styles.check} key={label}>
                {label}
              </div>
            ))}
          </Card>
          <Card title="Изменения после подтверждения">
            <dl className={styles.facts}>
              <div>
                <dt>Обеспечение</dt>
                <dd>
                  {formatInteger(changes.collateralBefore)} →{' '}
                  {formatInteger(changes.collateralAfter)}
                </dd>
              </div>
              <div>
                <dt>Предложение токенов</dt>
                <dd>
                  {formatInteger(changes.supplyBefore)} → {formatInteger(changes.supplyAfter)}
                </dd>
              </div>
            </dl>
          </Card>
          <div className={styles.notice}>
            Токены будут сожжены только после APPLIED-события GOODS_RELEASED.
          </div>
          {confirm.data === undefined ? null : (
            <Card title="Результат Oracle Gateway">
              <OracleStatus event={confirm.data.oracleEvent} />
            </Card>
          )}
          <Button
            disabled={!['TOKENS_LOCKED', 'IN_DELIVERY'].includes(order.status)}
            loading={confirm.isPending}
            onClick={submit}
          >
            Подписать факт отгрузки ЭЦП
          </Button>
        </div>
      </div>
    </div>
  );
}

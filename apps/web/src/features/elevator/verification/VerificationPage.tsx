import { useParams } from 'react-router-dom';
import { Button } from '../../../components/Button/Button.js';
import { Card } from '../../../components/Card/Card.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { formatInteger } from '../../../lib/integer-format.js';
import { useReserveVerification, useVerification } from '../api/queries.js';
import { OracleStatus } from '../OracleStatus.js';
import styles from '../Elevator.module.css';

export function VerificationPage() {
  const { requestId = '' } = useParams();
  const query = useVerification(requestId);
  const reserve = useReserveVerification(requestId);
  if (query.isPending) return <p>Загрузка…</p>;
  if (query.isError) return <p>Запрос не найден.</p>;
  const data = query.data;
  const submit = () => {
    if (globalThis.confirm('Подписание ЭЦП (будет подключено)')) reserve.mutate();
  };
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={`Запрос ${requestId}`}
        title="Проверка и резервирование партии"
        subtitle={`${data.request.commodity} · ${data.request.applicant}`}
      />
      <div className={styles.steps}>
        {['Документы', 'Количество и качество', 'Расписка', 'Резервирование', 'Подписание'].map(
          (step, index) => (
            <div className={index === 0 ? styles.stepActive : styles.step} key={step}>
              {index + 1}. {step}
            </div>
          ),
        )}
      </div>
      <div className={styles.columns}>
        <div className={styles.stack}>
          <Card title="Проверка документов">
            {data.documents.map((document) => (
              <div className={styles.check} key={document.name}>
                {document.name} — {document.status}
              </div>
            ))}
          </Card>
          <Card title="Электронная зерновая расписка">
            <dl className={styles.facts}>
              <div>
                <dt>ID расписки</dt>
                <dd>{data.receipt.receiptId}</dd>
              </div>
              <div>
                <dt>Правообладатель</dt>
                <dd>{data.receipt.owner}</dd>
              </div>
              <div>
                <dt>Товар</dt>
                <dd>{data.receipt.commodity}</dd>
              </div>
              <div>
                <dt>Статус</dt>
                <dd>{data.receipt.status}</dd>
              </div>
            </dl>
          </Card>
          <Card title="Сравнение количества">
            <dl className={styles.facts}>
              <div>
                <dt>Запрошено</dt>
                <dd>
                  {formatInteger(data.requestedQuantity)} {data.receipt.unit}
                </dd>
              </div>
              <div>
                <dt>Доступно без обременения</dt>
                <dd>
                  {formatInteger(data.availableQuantity)} {data.receipt.unit}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
        <div className={styles.stack}>
          <Card title="Результат проверки">
            {data.checks.map((check) => (
              <div className={styles.check} key={check.code}>
                {check.label} — {check.status}
              </div>
            ))}
          </Card>
          <Card title="Предпросмотр события для оракула">
            <pre className={styles.preview}>{JSON.stringify(data.eventPreview, null, 2)}</pre>
          </Card>
          {reserve.data === undefined ? null : (
            <Card title="Результат Oracle Gateway">
              <OracleStatus event={reserve.data.oracleEvent} />
            </Card>
          )}
          <Button
            disabled={data.request.status !== 'REQUIRES_REVIEW'}
            loading={reserve.isPending}
            onClick={submit}
          >
            Зарезервировать и подписать ЭЦП
          </Button>
        </div>
      </div>
    </div>
  );
}

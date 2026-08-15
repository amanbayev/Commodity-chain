import type { DataTableColumn } from '../components/DataTable/DataTable.js';
import type { PlatformStatus } from '../components/StatusBadge/StatusBadge.js';
import { Button } from '../components/Button/Button.js';
import { Card } from '../components/Card/Card.js';
import { DataTable } from '../components/DataTable/DataTable.js';
import { PageHeader } from '../components/PageHeader/PageHeader.js';
import { StatusBadge } from '../components/StatusBadge/StatusBadge.js';
import { tokens } from '../theme/tokens.js';
import styles from './StyleguidePage.module.css';

interface DemoRow {
  id: string;
  instrument: string;
  quantity: string;
  status: PlatformStatus;
}

const rows: DemoRow[] = [
  { id: '1', instrument: 'WHT-3-2026', quantity: '5000', status: 'ACTIVE' },
  { id: '2', instrument: 'BAR-2026', quantity: '2500', status: 'UNDER_REVIEW' },
  { id: '3', instrument: 'SUN-2026', quantity: '820', status: 'DRAFT' },
  { id: '4', instrument: 'WHT-4-2026', quantity: '12000', status: 'COLLATERALIZED' },
  { id: '5', instrument: 'WHT-3-2025', quantity: '100', status: 'SUSPENDED' },
  { id: '6', instrument: 'BAR-2025', quantity: '999', status: 'REJECTED' },
  { id: '7', instrument: 'SUN-2025', quantity: '1450', status: 'CLOSED' },
];

const columns: readonly DataTableColumn<DemoRow>[] = [
  {
    cell: (row) => row.instrument,
    header: 'Инструмент',
    id: 'instrument',
    sortable: true,
    value: (row) => row.instrument,
  },
  {
    align: 'right',
    cell: (row) => `${row.quantity} токенов`,
    header: 'Количество',
    id: 'quantity',
    sortable: true,
    value: (row) => row.quantity,
  },
  {
    cell: (row) => <StatusBadge status={row.status} />,
    header: 'Статус',
    id: 'status',
    sortable: true,
    value: (row) => row.status,
  },
];

const statuses: readonly PlatformStatus[] = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'COLLATERALIZED',
  'PRIMARY',
  'ACTIVE',
  'SUSPENDED',
  'REDEMPTION',
  'MATURED',
  'CLOSED',
  'DEFAULT',
  'NEW',
  'VALIDATING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'CANCEL_PENDING',
  'CANCELLED',
  'EXPIRED',
  'CREATED',
  'TOKENS_LOCKED',
  'IN_DELIVERY',
  'COMPLETED',
  'EXCEPTION',
  'QUARANTINED',
];

const swatches = [
  ['Navy', tokens.color.navy950],
  ['Gold', tokens.color.gold500],
  ['Teal', tokens.color.teal600],
  ['Success', tokens.color.green600],
  ['Danger', tokens.color.red600],
  ['Canvas', tokens.color.canvas],
] as const;

export function StyleguidePage() {
  return (
    <>
      <PageHeader
        actions={<Button>Основное действие</Button>}
        eyebrow="Design system v0.1"
        subtitle="Базовые визуальные элементы Commodity Chain, извлечённые из целевых интерфейсных макетов."
        title="Компоненты и состояния"
      />
      <div className={styles.grid}>
        <Card className={styles.full} title="Палитра">
          <div className={styles.swatches}>
            {swatches.map(([name, color]) => (
              <div className={styles.swatch} key={name}>
                <span style={{ background: color }} />
                <strong>{name}</strong>
                <code>{color}</code>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Кнопки">
          <div className={styles.row}>
            <Button>Primary gold</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Loading</Button>
          </div>
        </Card>
        <Card title="Статусы">
          <div className={styles.badges}>
            {statuses.map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
        </Card>
        <Card className={styles.full} title="Таблица данных">
          <DataTable columns={columns} data={rows} getRowId={(row) => row.id} initialPageSize={5} />
        </Card>
      </div>
    </>
  );
}

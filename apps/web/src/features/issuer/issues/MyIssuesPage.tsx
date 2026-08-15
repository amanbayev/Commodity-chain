import { useNavigate } from 'react-router-dom';

import { getUserErrorMessage } from '../../../api/errors.js';
import { Button } from '../../../components/Button/Button.js';
import { Card } from '../../../components/Card/Card.js';
import { DataTable, type DataTableColumn } from '../../../components/DataTable/DataTable.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { StatusBadge } from '../../../components/StatusBadge/StatusBadge.js';
import type { IssuerInstrumentSummary } from '../api/issuerApi.js';
import { useIssuerInstruments } from '../api/queries.js';
import styles from './MyIssuesPage.module.css';

export function IssuesTable({ issues }: { issues: readonly IssuerInstrumentSummary[] }) {
  const navigate = useNavigate();
  const columns: readonly DataTableColumn<IssuerInstrumentSummary>[] = [
    {
      cell: (issue) =>
        typeof issue.instrument.extensions?.['ticker'] === 'string'
          ? issue.instrument.extensions['ticker']
          : '—',
      header: 'Тикер',
      id: 'ticker',
      sortable: true,
      value: (issue) => String(issue.instrument.extensions?.['ticker'] ?? ''),
    },
    {
      cell: (issue) => issue.passport.underlyingAsset?.commodity ?? issue.instrument.type,
      header: 'Инструмент',
      id: 'instrument',
      value: (issue) => issue.passport.underlyingAsset?.commodity,
    },
    {
      cell: (issue) => <StatusBadge status={issue.instrument.status} />,
      header: 'Статус',
      id: 'status',
      sortable: true,
      value: (issue) => issue.instrument.status,
    },
    {
      align: 'right',
      cell: (issue) => String(issue.version),
      header: 'Версия паспорта',
      id: 'version',
      sortable: true,
      value: (issue) => BigInt(issue.version),
    },
    {
      cell: (issue) => (
        <div className={styles.actions}>
          <Button
            onClick={() => {
              navigate(`/my-issues/${issue.instrument.id}`);
            }}
            variant="secondary"
          >
            Открыть
          </Button>
          {issue.instrument.status === 'DRAFT' ? (
            <Button
              onClick={() => {
                navigate(`/create-token?id=${issue.instrument.id}`);
              }}
            >
              Продолжить черновик
            </Button>
          ) : null}
        </div>
      ),
      header: 'Действия',
      id: 'actions',
    },
  ];
  return (
    <DataTable
      columns={columns}
      data={issues}
      emptyMessage="Выпусков пока нет"
      getRowId={(issue) => issue.instrument.id}
      initialPageSize={10}
      pageSizeOptions={[10, 25, 50]}
    />
  );
}

export function MyIssuesPage() {
  const navigate = useNavigate();
  const issues = useIssuerInstruments();
  return (
    <>
      <PageHeader
        actions={
          <Button
            onClick={() => {
              navigate('/create-token');
            }}
          >
            Создать токен
          </Button>
        }
        eyebrow="Эмитент"
        subtitle="Черновики, листинговые заявки и активные товарные токены."
        title="Мои выпуски"
      />
      <Card>
        {issues.isError ? (
          <p className={styles.error} role="alert">
            {getUserErrorMessage(issues.error)}
          </p>
        ) : null}
        <IssuesTable issues={issues.data?.items ?? []} />
        {issues.isLoading ? <p className={styles.loading}>Загрузка выпусков…</p> : null}
      </Card>
    </>
  );
}

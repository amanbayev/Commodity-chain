import { useNavigate } from 'react-router-dom';

import { DataTable, type DataTableColumn } from '../../../components/DataTable/DataTable.js';
import { StatusBadge } from '../../../components/StatusBadge/StatusBadge.js';
import { formatBasisPoints, formatInteger, formatMoney } from '../../../lib/integer-format.js';
import type { InstrumentMarketItem } from '../api/investorApi.js';
import styles from './MarketTable.module.css';

export interface MarketTableProps {
  instruments: readonly InstrumentMarketItem[];
}

export function MarketTable({ instruments }: MarketTableProps) {
  const navigate = useNavigate();
  const columns: readonly DataTableColumn<InstrumentMarketItem>[] = [
    {
      cell: (item) => (
        <div className={styles.instrument}>
          <strong>{item.name}</strong>
          <span>{item.ticker ?? '—'}</span>
        </div>
      ),
      header: 'Инструмент',
      id: 'instrument',
      sortable: true,
      value: (item) => item.name,
    },
    {
      align: 'right',
      cell: (item) =>
        item.lastTradePrice === undefined
          ? '—'
          : formatMoney(item.lastTradePrice, item.instrument.currency),
      header: 'Последняя цена',
      id: 'price',
      sortable: true,
      value: (item) => item.lastTradePrice,
    },
    {
      align: 'right',
      cell: (item) =>
        item.priceChangeBps === undefined ? (
          '—'
        ) : (
          <span className={BigInt(item.priceChangeBps) < 0n ? styles.negative : styles.positive}>
            {formatBasisPoints(item.priceChangeBps)}
          </span>
        ),
      header: 'Изменение (24ч)',
      id: 'change',
      sortable: true,
      value: (item) => item.priceChangeBps,
    },
    {
      align: 'right',
      cell: (item) => formatInteger(item.availableSupply),
      header: 'Доступное предложение',
      id: 'supply',
      sortable: true,
      value: (item) => item.availableSupply,
    },
    {
      cell: (item) => <StatusBadge status={item.instrument.status} />,
      header: 'Статус',
      id: 'status',
      sortable: true,
      value: (item) => item.instrument.status,
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={instruments}
      emptyMessage="Публичные инструменты пока отсутствуют"
      getRowId={(item) => item.instrument.id}
      initialPageSize={10}
      onRowClick={(item) => {
        navigate(`/market/${item.instrument.id}`);
      }}
      pageSizeOptions={[10, 20, 50]}
    />
  );
}

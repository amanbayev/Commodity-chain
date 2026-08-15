import { useState } from 'react';

import { Button } from '../../../components/Button/Button.js';
import { DataTable, type DataTableColumn } from '../../../components/DataTable/DataTable.js';
import { StatusBadge } from '../../../components/StatusBadge/StatusBadge.js';
import { formatInteger, formatMoney, subtractIntegerStrings } from '../../../lib/integer-format.js';
import type { InstrumentMarketItem, Order } from '../api/investorApi.js';
import styles from './OrdersTable.module.css';

export interface OrdersTableProps {
  instruments: readonly InstrumentMarketItem[];
  onCancel: (orderId: string) => Promise<unknown>;
  orders: readonly Order[];
}

const cancellableStatuses = new Set<Order['status']>(['ACCEPTED', 'OPEN', 'PARTIALLY_FILLED']);

export function OrdersTable({ instruments, onCancel, orders }: OrdersTableProps) {
  const [selected, setSelected] = useState<Order>();
  const [cancelling, setCancelling] = useState(false);
  const instrumentNames = new Map(
    instruments.map((item) => [item.instrument.id, item.ticker ?? item.name]),
  );
  const columns: readonly DataTableColumn<Order>[] = [
    {
      cell: (order) => instrumentNames.get(order.instrumentId) ?? order.instrumentId,
      header: 'Инструмент',
      id: 'instrument',
      sortable: true,
      value: (order) => instrumentNames.get(order.instrumentId) ?? order.instrumentId,
    },
    {
      cell: (order) => (
        <span className={order.side === 'BUY' ? styles.buy : styles.sell}>
          {order.side === 'BUY' ? 'Покупка' : 'Продажа'}
        </span>
      ),
      header: 'Сторона',
      id: 'side',
      sortable: true,
      value: (order) => order.side,
    },
    { cell: (order) => order.type, header: 'Тип', id: 'type', value: (order) => order.type },
    {
      align: 'right',
      cell: (order) =>
        order.price === undefined
          ? '—'
          : formatMoney(
              order.price,
              instruments.find((item) => item.instrument.id === order.instrumentId)?.instrument
                .currency ?? 'KZT',
            ),
      header: 'Цена',
      id: 'price',
      value: (order) => order.price,
    },
    {
      align: 'right',
      cell: (order) => formatInteger(order.quantity),
      header: 'Количество',
      id: 'quantity',
      value: (order) => order.quantity,
    },
    {
      align: 'right',
      cell: (order) => formatInteger(subtractIntegerStrings(order.quantity, order.openQuantity)),
      header: 'Исполнено',
      id: 'filled',
      value: (order) => subtractIntegerStrings(order.quantity, order.openQuantity),
    },
    {
      cell: (order) => <StatusBadge status={order.status} />,
      header: 'Статус',
      id: 'status',
      sortable: true,
      value: (order) => order.status,
    },
    {
      cell: (order) =>
        cancellableStatuses.has(order.status) ? (
          <Button
            aria-label={`Отменить заявку ${order.id}`}
            onClick={() => {
              setSelected(order);
            }}
            variant="secondary"
          >
            Отменить
          </Button>
        ) : (
          '—'
        ),
      header: 'Действия',
      id: 'actions',
    },
  ];

  const confirmCancel = async () => {
    if (selected === undefined) return;
    setCancelling(true);
    try {
      await onCancel(selected.id);
      setSelected(undefined);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <DataTable
        columns={columns}
        data={orders}
        emptyMessage="Заявок пока нет"
        getRowId={(order) => order.id}
        initialPageSize={10}
        pageSizeOptions={[10, 25, 50]}
      />
      {selected === undefined ? null : (
        <div
          aria-labelledby="cancel-title"
          aria-modal="true"
          className={styles.backdrop}
          role="dialog"
        >
          <div className={styles.dialog}>
            <h2 id="cancel-title">Отменить заявку?</h2>
            <p>
              Открытый остаток {formatInteger(selected.openQuantity)} токенов будет снят с торгов,
              резерв — освобождён.
            </p>
            <div>
              <Button
                disabled={cancelling}
                onClick={() => {
                  setSelected(undefined);
                }}
                variant="secondary"
              >
                Не отменять
              </Button>
              <Button
                loading={cancelling}
                onClick={() => {
                  void confirmCancel();
                }}
                variant="danger"
              >
                Подтвердить отмену
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

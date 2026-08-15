import { useState } from 'react';
import type { ReactNode } from 'react';

import styles from './DataTable.module.css';

export interface DataTableColumn<T> {
  align?: 'left' | 'right';
  cell: (row: T) => ReactNode;
  compare?: (left: T, right: T) => number;
  header: string;
  id: string;
  sortable?: boolean;
  value?: (row: T) => bigint | boolean | string | null | undefined;
}

export interface DataTableProps<T> {
  caption?: string;
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  emptyMessage?: string;
  getRowId: (row: T) => string;
  initialPageSize?: number;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  pageSizeOptions?: readonly number[];
}

type SortDirection = 'asc' | 'desc';

function compareValues(
  left: bigint | boolean | string | null | undefined,
  right: bigint | boolean | string | null | undefined,
): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === 'bigint' && typeof right === 'bigint') return left < right ? -1 : 1;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left ? 1 : -1;

  const leftText = String(left);
  const rightText = String(right);
  if (/^-?\d+$/.test(leftText) && /^-?\d+$/.test(rightText)) {
    const leftInteger = BigInt(leftText);
    const rightInteger = BigInt(rightText);
    return leftInteger === rightInteger ? 0 : leftInteger < rightInteger ? -1 : 1;
  }
  return leftText.localeCompare(rightText, 'ru');
}

export function DataTable<T>({
  caption,
  columns,
  data,
  emptyMessage = 'Нет данных',
  getRowId,
  initialPageSize = 5,
  loading = false,
  onRowClick,
  pageSizeOptions = [5, 10, 20],
}: DataTableProps<T>) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [sort, setSort] = useState<{ direction: SortDirection; id: string } | null>(null);

  const sorted = [...data];
  if (sort !== null) {
    const column = columns.find(({ id }) => id === sort.id);
    if (column !== undefined) {
      sorted.sort((left, right) => {
        const result =
          column.compare?.(left, right) ??
          compareValues(column.value?.(left), column.value?.(right));
        return sort.direction === 'asc' ? result : -result;
      });
    }
  }

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const toggleSort = (id: string) => {
    setPage(0);
    setSort((current) =>
      current?.id === id && current.direction === 'asc'
        ? { direction: 'desc', id }
        : { direction: 'asc', id },
    );
  };

  return (
    <div className={styles.frame}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          {caption === undefined ? null : <caption>{caption}</caption>}
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.id === column.id;
                return (
                  <th className={styles[column.align ?? 'left']} key={column.id} scope="col">
                    {column.sortable === true ? (
                      <button
                        aria-label={`Сортировать по ${column.header}`}
                        className={styles.sortButton}
                        onClick={() => {
                          toggleSort(column.id);
                        }}
                        type="button"
                      >
                        {column.header}
                        <span
                          aria-hidden="true"
                          className={active ? styles.sortActive : styles.sortIcon}
                        >
                          {active && sort.direction === 'desc' ? '↓' : '↑'}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className={styles.state} colSpan={columns.length}>
                  Загрузка…
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td className={styles.state} colSpan={columns.length}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => (
                <tr
                  className={onRowClick === undefined ? undefined : styles.clickable}
                  key={getRowId(row)}
                  onClick={
                    onRowClick === undefined
                      ? undefined
                      : () => {
                          onRowClick(row);
                        }
                  }
                  onKeyDown={
                    onRowClick === undefined
                      ? undefined
                      : (event) => {
                          if (event.key === 'Enter' || event.key === ' ') onRowClick(row);
                        }
                  }
                  tabIndex={onRowClick === undefined ? undefined : 0}
                >
                  {columns.map((column) => (
                    <td className={styles[column.align ?? 'left']} key={column.id}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <footer className={styles.pagination}>
        <label className={styles.pageSize}>
          Строк на странице
          <select
            aria-label="Строк на странице"
            onChange={(event) => {
              setPage(0);
              setPageSize(Number(event.target.value));
            }}
            value={pageSize}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <span>
          {sorted.length === 0 ? 0 : safePage * pageSize + 1}–
          {Math.min((safePage + 1) * pageSize, sorted.length)} из {sorted.length}
        </span>
        <div className={styles.pageButtons}>
          <button
            aria-label="Предыдущая страница"
            disabled={safePage === 0}
            onClick={() => {
              setPage(safePage - 1);
            }}
            type="button"
          >
            ‹
          </button>
          <button
            aria-label="Следующая страница"
            disabled={safePage >= pageCount - 1}
            onClick={() => {
              setPage(safePage + 1);
            }}
            type="button"
          >
            ›
          </button>
        </div>
      </footer>
    </div>
  );
}

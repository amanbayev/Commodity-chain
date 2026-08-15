// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { DataTableColumn } from './DataTable.js';
import { DataTable } from './DataTable.js';

interface Row {
  id: string;
  name: string;
  quantity: string;
}

const columns: readonly DataTableColumn<Row>[] = [
  { cell: (row) => row.name, header: 'Название', id: 'name', value: (row) => row.name },
  {
    cell: (row) => row.quantity,
    header: 'Количество',
    id: 'quantity',
    sortable: true,
    value: (row) => row.quantity,
  },
];

const rows: Row[] = [
  { id: 'a', name: 'Альфа', quantity: '10000000000000000000' },
  { id: 'b', name: 'Бета', quantity: '2' },
  { id: 'c', name: 'Гамма', quantity: '30' },
];

afterEach(cleanup);

describe('DataTable', () => {
  it('sorts integer strings exactly with bigint semantics', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        initialPageSize={3}
        pageSizeOptions={[3]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Сортировать по Количество' }));

    const renderedRows = screen.getAllByRole('row');
    expect(within(renderedRows[1]!).getByText('Бета')).toBeInTheDocument();
    expect(within(renderedRows[3]!).getByText('Альфа')).toBeInTheDocument();
  });

  it('paginates rows without losing table semantics', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        initialPageSize={2}
        pageSizeOptions={[2]}
      />,
    );

    expect(screen.queryByText('Гамма')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Следующая страница' }));
    expect(screen.getByText('Гамма')).toBeInTheDocument();
    expect(screen.getByText('3–3 из 3')).toBeInTheDocument();
  });
});

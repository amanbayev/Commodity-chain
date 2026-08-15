import { Card } from '../../../components/Card/Card.js';
import { formatInteger, formatMoney } from '../../../lib/integer-format.js';
import type { OrderBook } from '../api/investorApi.js';
import styles from './OrderBookPanel.module.css';

export interface OrderBookPanelProps {
  book: OrderBook | undefined;
  currency: string;
}

export function OrderBookPanel({ book, currency }: OrderBookPanelProps) {
  return (
    <Card title="Книга заявок (T+0)">
      <div className={styles.grid}>
        <table className={styles.bids}>
          <caption>Покупка</caption>
          <thead>
            <tr>
              <th>Цена</th>
              <th>Объём</th>
              <th>Заявок</th>
            </tr>
          </thead>
          <tbody>
            {book?.bids.length === 0 || book === undefined ? (
              <tr>
                <td colSpan={3}>—</td>
              </tr>
            ) : (
              book.bids.map((level) => (
                <tr key={level.price}>
                  <td>{formatMoney(level.price, currency)}</td>
                  <td>{formatInteger(level.quantity)}</td>
                  <td>{level.orderCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <table className={styles.asks}>
          <caption>Продажа</caption>
          <thead>
            <tr>
              <th>Цена</th>
              <th>Объём</th>
              <th>Заявок</th>
            </tr>
          </thead>
          <tbody>
            {book?.asks.length === 0 || book === undefined ? (
              <tr>
                <td colSpan={3}>—</td>
              </tr>
            ) : (
              book.asks.map((level) => (
                <tr key={level.price}>
                  <td>{formatMoney(level.price, currency)}</td>
                  <td>{formatInteger(level.quantity)}</td>
                  <td>{level.orderCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className={styles.sequence}>Sequencer: {book?.sequence ?? '—'}</p>
    </Card>
  );
}

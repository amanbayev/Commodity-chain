import { Card } from '../../../components/Card/Card.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { getUserErrorMessage } from '../../../api/errors.js';
import { formatInteger, formatMoney } from '../../../lib/integer-format.js';
import { useMarketInstruments } from '../api/queries.js';
import type { InstrumentMarketItem } from '../api/investorApi.js';
import { MarketTable } from './MarketTable.js';
import styles from './MarketPage.module.css';

function marketSummary(items: readonly InstrumentMarketItem[]) {
  if (items.length === 0) return { issued: '—', volume: '—' };
  const issued = items.reduce(
    (total, item) => total + BigInt(item.instrument.circulatingSupply),
    0n,
  );
  const currencies = new Set(items.map((item) => item.instrument.currency));
  const volume = items.reduce((total, item) => total + BigInt(item.tradingVolume24h), 0n);
  return {
    issued: `${formatInteger(issued)} токенов`,
    volume: currencies.size === 1 ? formatMoney(volume, items[0]!.instrument.currency) : '—',
  };
}

export function MarketPage() {
  const market = useMarketInstruments();
  const items = market.data?.items ?? [];
  const summary = marketSummary(items);

  return (
    <>
      <PageHeader
        eyebrow="Инвестор"
        subtitle="Публичные токенизированные товарные инструменты."
        title="Обзор рынка"
      />
      <div className={styles.summary}>
        <Card>
          <div className={styles.metric}>
            <span>Объём торгов (24ч)</span>
            <strong>{summary.volume}</strong>
            <small>Только подтверждённые сделки API</small>
          </div>
        </Card>
        <Card>
          <div className={styles.metric}>
            <span>Выпущено токенов</span>
            <strong>{summary.issued}</strong>
            <small>Текущее обращение по инструментам</small>
          </div>
        </Card>
        <Card>
          <div className={styles.metric}>
            <span>Публичных инструментов</span>
            <strong>{market.data === undefined ? '—' : formatInteger(String(items.length))}</strong>
            <small>С опубликованным паспортом</small>
          </div>
        </Card>
      </div>
      <Card title="Токенизированные инструменты">
        {market.isError ? (
          <div className={styles.error} role="alert">
            {getUserErrorMessage(market.error)}
          </div>
        ) : null}
        <MarketTable instruments={items} />
        {market.isLoading ? <p className={styles.loading}>Загрузка рыночных данных…</p> : null}
      </Card>
    </>
  );
}

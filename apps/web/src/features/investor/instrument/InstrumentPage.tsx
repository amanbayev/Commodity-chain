import { useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { getUserErrorMessage } from '../../../api/errors.js';
import { Card } from '../../../components/Card/Card.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { StatusBadge } from '../../../components/StatusBadge/StatusBadge.js';
import { formatInteger, formatMoney } from '../../../lib/integer-format.js';
import {
  useInstrumentPassport,
  useMarketInstruments,
  useOrderBook,
  useSubmitOrder,
} from '../api/queries.js';
import { OrderBookPanel } from './OrderBookPanel.js';
import { OrderTicket } from './OrderTicket.js';
import { PassportView } from './PassportView.js';
import styles from './InstrumentPage.module.css';

type Tab = 'overview' | 'passport' | 'orderbook';

export function InstrumentPage() {
  const { instrumentId = '' } = useParams();
  const [tab, setTab] = useState<Tab>('overview');
  const market = useMarketInstruments();
  const passport = useInstrumentPassport(instrumentId);
  const orderBook = useOrderBook(instrumentId);
  const submitOrder = useSubmitOrder();
  if (instrumentId.length === 0) return <Navigate replace to="/market" />;

  if (passport.isLoading) return <p className={styles.loading}>Загрузка паспорта инструмента…</p>;
  if (passport.isError || passport.data === undefined) {
    return (
      <div className={styles.error} role="alert">
        {getUserErrorMessage(passport.error)}
      </div>
    );
  }

  const value = passport.data;
  const marketItem = market.data?.items.find((item) => item.instrument.id === instrumentId);
  const asset = value.passport.underlyingAsset;
  const custody = value.passport.custodyAndVerification;
  const trading = value.passport.tradingParameters;
  const initialPrice =
    orderBook.data?.asks[0]?.price ??
    marketItem?.lastTradePrice ??
    value.passport.economics?.issuePrice;
  const reserved = value.collateralPositions.reduce(
    (total, position) => total + BigInt(position.reserved),
    0n,
  );

  return (
    <>
      <PageHeader
        actions={<StatusBadge status={value.instrument.status} />}
        eyebrow={marketItem?.ticker ?? value.instrument.id}
        subtitle={`1 токен = ${formatInteger(value.instrument.unitPerToken)} ${value.instrument.unit}`}
        title={marketItem?.name ?? asset?.commodity ?? 'Товарный токен'}
      />
      <div className={styles.hero}>
        <Card>
          <div className={styles.quote}>
            <span>Последняя цена</span>
            <strong>
              {marketItem?.lastTradePrice === undefined
                ? '—'
                : formatMoney(marketItem.lastTradePrice, value.instrument.currency)}
            </strong>
            <small>Только данные подтверждённых сделок</small>
          </div>
        </Card>
        <Card>
          <div className={styles.collateral}>
            <div>
              <span aria-hidden="true" className={styles.shield}>
                ✓
              </span>
              <strong>Обеспечение подтверждено</strong>
            </div>
            <dl>
              <dt>Хранитель</dt>
              <dd>{custody?.custodianId ?? '—'}</dd>
              <dt>Верификаторы</dt>
              <dd>{custody?.verifierIds.join(', ') || '—'}</dd>
              <dt>Зарезервировано</dt>
              <dd>
                {formatInteger(reserved)} {value.instrument.unit}
              </dd>
            </dl>
          </div>
        </Card>
      </div>
      <div className={styles.workspace}>
        <Card>
          <div className={styles.tabs} role="tablist">
            <button
              aria-selected={tab === 'overview'}
              onClick={() => {
                setTab('overview');
              }}
              role="tab"
              type="button"
            >
              Обзор
            </button>
            <button
              aria-selected={tab === 'passport'}
              onClick={() => {
                setTab('passport');
              }}
              role="tab"
              type="button"
            >
              Паспорт токена
            </button>
            <button
              aria-selected={tab === 'orderbook'}
              onClick={() => {
                setTab('orderbook');
              }}
              role="tab"
              type="button"
            >
              Стакан
            </button>
          </div>
          {tab === 'overview' ? (
            <dl className={styles.overview}>
              <dt>Базовый актив</dt>
              <dd>{asset === undefined ? '—' : `${asset.commodity}, ${asset.grade}`}</dd>
              <dt>Страна происхождения</dt>
              <dd>{asset?.originCountry ?? '—'}</dd>
              <dt>Место хранения</dt>
              <dd>{asset?.storageLocation ?? '—'}</dd>
              <dt>Объём в обращении</dt>
              <dd>{formatInteger(value.instrument.circulatingSupply)} токенов</dd>
              <dt>Лимит выпуска</dt>
              <dd>{formatInteger(value.instrument.supplyCap)} токенов</dd>
              <dt>Минимальный лот</dt>
              <dd>{formatInteger(trading?.lotSize ?? '1')} токенов</dd>
            </dl>
          ) : null}
          {tab === 'passport' ? <PassportView value={value} /> : null}
          {tab === 'orderbook' ? (
            orderBook.isError ? (
              <p className={styles.error} role="alert">
                {getUserErrorMessage(orderBook.error)}
              </p>
            ) : (
              <OrderBookPanel book={orderBook.data} currency={value.instrument.currency} />
            )
          ) : null}
        </Card>
        <Card title="Создать заявку">
          <OrderTicket
            currency={value.instrument.currency}
            initialPrice={initialPrice ?? ''}
            instrumentId={instrumentId}
            lotSize={trading?.lotSize ?? '1'}
            onSubmit={submitOrder.mutateAsync}
          />
        </Card>
      </div>
    </>
  );
}

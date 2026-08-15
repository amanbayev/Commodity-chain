import { Navigate, useParams } from 'react-router-dom';

import { getUserErrorMessage } from '../../../api/errors.js';
import { Card } from '../../../components/Card/Card.js';
import { PageHeader } from '../../../components/PageHeader/PageHeader.js';
import { StatusBadge } from '../../../components/StatusBadge/StatusBadge.js';
import { formatBasisPoints, formatInteger, formatMoney } from '../../../lib/integer-format.js';
import { useInstrumentCollateral, useIssuerInstrument } from '../api/queries.js';
import { availableForPlacement, collateralCoverageBps } from './issuerMetrics.js';
import styles from './IssueDetailPage.module.css';

const statusRank: Readonly<Record<string, number>> = {
  APPROVED: 1,
  COLLATERALIZED: 2,
  PRIMARY: 3,
  ACTIVE: 4,
};

export function IssueDetailPage() {
  const { id = '' } = useParams();
  const issue = useIssuerInstrument(id);
  const collateral = useInstrumentCollateral(id);
  if (id.length === 0) return <Navigate replace to="/my-issues" />;
  if (issue.isLoading) return <p>Загрузка выпуска…</p>;
  if (issue.isError || issue.data === undefined)
    return (
      <p className={styles.error} role="alert">
        {getUserErrorMessage(issue.error)}
      </p>
    );
  const value = issue.data;
  const passport = value.passport;
  const ticker =
    typeof value.instrument.extensions?.['ticker'] === 'string'
      ? value.instrument.extensions['ticker']
      : value.instrument.id;
  const rank = statusRank[value.instrument.status] ?? 0;
  const verified = collateral.data?.verifiedAvailable ?? value.verifiedAvailable;
  const coverage = collateralCoverageBps(
    verified,
    value.instrument.supplyCap,
    value.instrument.unitPerToken,
  );
  const available = availableForPlacement(
    value.instrument.supplyCap,
    value.instrument.circulatingSupply,
  );

  return (
    <>
      <PageHeader
        actions={<StatusBadge status={value.instrument.status} />}
        eyebrow={`Версия ${value.version}`}
        subtitle={
          passport.underlyingAsset === undefined
            ? value.instrument.type
            : `${passport.underlyingAsset.commodity}, ${passport.underlyingAsset.grade}`
        }
        title={ticker}
      />
      <div className={styles.lifecycle}>
        {['Одобрено', 'Смарт-контракт', 'Первичное размещение', 'Вторичные торги'].map(
          (label, index) => (
            <div className={rank >= index + 1 ? styles.done : ''} key={label}>
              <b>{rank >= index + 1 ? '✓' : index + 1}</b>
              <span>{label}</span>
            </div>
          ),
        )}
      </div>
      {value.instrument.status === 'PRIMARY' ? (
        <Card title="Первичное размещение">
          <div className={styles.managed}>Управляется правилами выпуска</div>
          <div className={styles.primary}>
            <dl>
              <dt>Метод размещения</dt>
              <dd>Фиксированная цена</dd>
              <dt>Цена размещения</dt>
              <dd>
                {passport.economics === undefined
                  ? '—'
                  : formatMoney(passport.economics.issuePrice, passport.economics.issueCurrency)}
              </dd>
              <dt>Минимальная заявка</dt>
              <dd>
                {passport.tradingParameters === undefined
                  ? '—'
                  : formatInteger(passport.tradingParameters.minimumOrderQuantity)}
              </dd>
              <dt>Расчёты</dt>
              <dd>{passport.tradingParameters?.settlementCycle.replaceAll('_', ' ') ?? '—'}</dd>
            </dl>
            <dl>
              <dt>Общий выпуск</dt>
              <dd>{formatInteger(value.instrument.supplyCap)} токенов</dd>
              <dt>Доступно</dt>
              <dd>{formatInteger(available)} токенов</dd>
              <dt>Подтверждённое обеспечение</dt>
              <dd>
                {formatInteger(verified)} {value.instrument.unit}
              </dd>
              <dt>Коэффициент покрытия</dt>
              <dd>{coverage === null ? '—' : formatBasisPoints(coverage)}</dd>
            </dl>
          </div>
        </Card>
      ) : null}
      <div className={styles.grid}>
        <Card title="Паспорт выпуска">
          <dl>
            <dt>Базовый актив</dt>
            <dd>
              {passport.underlyingAsset?.commodity ?? '—'} {passport.underlyingAsset?.grade ?? ''}
            </dd>
            <dt>Правовая природа</dt>
            <dd>{value.instrument.legalNature}</dd>
            <dt>Хранитель</dt>
            <dd>{passport.custodyAndVerification?.custodianId ?? '—'}</dd>
            <dt>Верификаторы</dt>
            <dd>{passport.custodyAndVerification?.verifierIds.join(', ') ?? '—'}</dd>
            <dt>Maturity</dt>
            <dd>{passport.economics?.maturityDate ?? '—'}</dd>
          </dl>
        </Card>
        <Card title="Целостность и обеспечение">
          <dl>
            <dt>Хэш паспорта</dt>
            <dd className={styles.hash}>{value.passportHash ?? 'Будет сформирован при submit'}</dd>
            <dt>Версия</dt>
            <dd>{value.version}</dd>
            <dt>Обеспечение</dt>
            <dd>
              {formatInteger(verified)} {value.instrument.unit}
            </dd>
            <dt>Позиций</dt>
            <dd>{collateral.data?.positions.length ?? value.collateralPositions.length}</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}

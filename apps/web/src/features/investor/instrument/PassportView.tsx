import { Card } from '../../../components/Card/Card.js';
import { formatInteger, formatMoney } from '../../../lib/integer-format.js';
import type { InstrumentPassport } from '../api/investorApi.js';
import styles from './PassportView.module.css';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function PassportView({ value }: { value: InstrumentPassport }) {
  const passport = value.passport;
  const asset = passport.underlyingAsset;
  const rights = passport.holderRights;
  const custody = passport.custodyAndVerification;
  const economics = passport.economics;
  const trading = passport.tradingParameters;

  return (
    <div className={styles.sections}>
      <Card title="Базовый актив">
        <dl>
          {asset === undefined ? (
            <Field label="Данные" value="—" />
          ) : (
            <>
              <Field label="Товар" value={`${asset.commodity}, ${asset.grade}`} />
              <Field label="Класс актива" value={asset.assetClass} />
              <Field label="Страна происхождения" value={asset.originCountry} />
              <Field label="Место хранения" value={asset.storageLocation} />
              <Field label="Стандарт качества" value={asset.qualityStandard ?? '—'} />
            </>
          )}
        </dl>
      </Card>
      <Card title="Права держателя">
        <dl>
          {rights === undefined ? (
            <Field label="Данные" value="—" />
          ) : (
            <>
              <Field label="Правовая природа" value={rights.legalTitle} />
              <Field label="Содержание требования" value={rights.claimDescription} />
              <Field label="Применимое право" value={rights.governingLaw} />
              <Field label="Погашение" value={rights.redemptionMethods.join(', ')} />
              <Field
                label="Ограничения передачи"
                value={rights.transferRestrictions.join(', ') || 'Нет'}
              />
            </>
          )}
        </dl>
      </Card>
      <Card title="Хранение и верификация">
        <dl>
          {custody === undefined ? (
            <Field label="Данные" value="—" />
          ) : (
            <>
              <Field label="Хранитель" value={custody.custodianId} />
              <Field label="Реестр" value={custody.registryId} />
              <Field label="Верификаторы" value={custody.verifierIds.join(', ')} />
              <Field
                label="Требования к доказательствам"
                value={custody.evidenceRequirements?.join(', ') ?? '—'}
              />
            </>
          )}
        </dl>
      </Card>
      <Card title="Экономика">
        <dl>
          {economics === undefined ? (
            <Field label="Данные" value="—" />
          ) : (
            <>
              <Field
                label="Цена выпуска"
                value={formatMoney(economics.issuePrice, economics.issueCurrency)}
              />
              <Field label="Дата погашения" value={economics.maturityDate} />
              <Field
                label="Комиссии паспорта"
                value={
                  economics.feeSchedule.length === 0
                    ? '—'
                    : economics.feeSchedule
                        .map((fee) => `${fee.feeType}: ${formatMoney(fee.amount, fee.currency)}`)
                        .join('; ')
                }
              />
            </>
          )}
        </dl>
      </Card>
      <Card title="Торговые параметры">
        <dl>
          {trading === undefined ? (
            <Field label="Данные" value="—" />
          ) : (
            <>
              <Field
                label="Шаг цены"
                value={formatMoney(trading.tickSize, value.instrument.currency)}
              />
              <Field label="Торговый лот" value={formatInteger(trading.lotSize)} />
              <Field
                label="Минимальная заявка"
                value={formatInteger(trading.minimumOrderQuantity)}
              />
              <Field
                label="Минимальная поставка"
                value={formatInteger(trading.minimumDeliveryQuantity)}
              />
              <Field label="Расчёты" value={trading.settlementCycle.replaceAll('_', ' ')} />
            </>
          )}
        </dl>
      </Card>
      <Card title="Версия и целостность">
        <dl>
          <Field label="Версия" value={String(value.version)} />
          <Field label="Хэш паспорта" value={value.passportHash} />
          <Field label="Опубликован" value={new Date(value.publishedAt).toLocaleString('ru-RU')} />
        </dl>
      </Card>
    </div>
  );
}

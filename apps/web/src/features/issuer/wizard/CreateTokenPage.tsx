import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ApiError, getUserErrorMessage } from '../../../api/errors.js';
import { Button } from '../../../components/Button/Button.js';
import { Card } from '../../../components/Card/Card.js';
import { StatusBadge } from '../../../components/StatusBadge/StatusBadge.js';
import { formatInteger } from '../../../lib/integer-format.js';
import { useDraftCommands, useIssuerInstrument } from '../api/queries.js';
import {
  buildDraft,
  buildDraftUpdate,
  completedSteps,
  initialWizardModel,
  missingFieldStep,
  modelFromIssue,
  readinessPercent,
  validateStep,
  type WizardDocument,
  type WizardModel,
} from './wizardModel.js';
import styles from './CreateTokenPage.module.css';

const steps = [
  'Базовый актив',
  'Права держателя',
  'Хранитель и верификация',
  'Экономика',
  'Торги',
  'Проверка',
] as const;

type Change = (field: keyof WizardModel, value: string | WizardDocument[]) => void;

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        aria-label={label}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        type={type}
        value={value}
      />
    </label>
  );
}

function StepOne({ model, change }: { model: WizardModel; change: Change }) {
  const selectFiles = (files: FileList | null) => {
    if (files === null) return;
    // TODO(CC-ESIGN-UPLOAD): upload document bytes through the future document adapter.
    change(
      'documents',
      [...files].map((file) => ({
        name: file.name,
        size: BigInt(file.size).toString(),
        mediaType: file.type || 'application/octet-stream',
      })),
    );
  };
  return (
    <div className={styles.stepBody}>
      <h2>Базовый актив и документы</h2>
      <div className={styles.categories}>
        {[
          'PHYSICAL_GOOD',
          'INTELLECTUAL_PROPERTY',
          'NATURAL_RESOURCE',
          'DIGITAL_ASSET',
          'OTHER',
        ].map((category) => (
          <button
            aria-pressed={model.assetClass === category}
            key={category}
            onClick={() => {
              change('assetClass', category);
            }}
            type="button"
          >
            {category === 'PHYSICAL_GOOD' ? 'Физический товар' : category.replaceAll('_', ' ')}
          </button>
        ))}
      </div>
      <div className={styles.fields}>
        <Field
          label="Название товара"
          onChange={(value) => {
            change('commodity', value);
          }}
          value={model.commodity}
        />
        <Field
          label="Класс качества"
          onChange={(value) => {
            change('grade', value);
          }}
          value={model.grade}
        />
        <Field
          label="Объём актива"
          onChange={(value) => {
            change('assetQuantity', value);
          }}
          value={model.assetQuantity}
        />
        <Field
          label="Единица измерения"
          onChange={(value) => {
            change('unit', value.toUpperCase());
          }}
          value={model.unit}
        />
        <Field
          label="Страна происхождения (ISO)"
          onChange={(value) => {
            change('originCountry', value.toUpperCase());
          }}
          value={model.originCountry}
        />
        <Field
          label="Место хранения"
          onChange={(value) => {
            change('storageLocation', value);
          }}
          value={model.storageLocation}
        />
        <Field
          label="Стандарт качества"
          onChange={(value) => {
            change('qualityStandard', value);
          }}
          value={model.qualityStandard}
        />
      </div>
      <label className={styles.upload}>
        Добавить документы
        <input
          aria-label="Документы актива"
          multiple
          onChange={(event) => {
            selectFiles(event.target.files);
          }}
          type="file"
        />
      </label>
      <ul className={styles.documents}>
        {model.documents.map((document) => (
          <li key={`${document.name}:${document.size}`}>
            {document.name}
            <span>{formatInteger(document.size)} байт</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepTwo({ model, change }: { model: WizardModel; change: Change }) {
  return (
    <div className={styles.stepBody}>
      <h2>Права держателя</h2>
      <label className={styles.field}>
        <span>Правовая модель</span>
        <select
          aria-label="Правовая модель"
          onChange={(event) => {
            change('legalNature', event.target.value);
          }}
          value={model.legalNature}
        >
          {[
            'CLAIM_RIGHT',
            'OWNERSHIP',
            'INCOME_SHARE',
            'LICENSE',
            'ACCESS',
            'DIGITAL_GOOD',
            'INVESTMENT',
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <div className={styles.fields}>
        <Field
          label="Количество актива на 1 токен"
          onChange={(value) => {
            change('unitPerToken', value);
          }}
          value={model.unitPerToken}
        />
        <Field
          label="Применимое право"
          onChange={(value) => {
            change('governingLaw', value);
          }}
          value={model.governingLaw}
        />
      </div>
      <label className={styles.field}>
        <span>Раскрытие права «1 токен = …»</span>
        <textarea
          aria-label="Описание права держателя"
          onChange={(event) => {
            change('claimDescription', event.target.value);
          }}
          value={model.claimDescription}
        />
      </label>
      <label className={styles.field}>
        <span>Раскрытие «не является …»</span>
        <textarea
          aria-label="Ограничения права"
          onChange={(event) => {
            change('nonOwnershipDisclosure', event.target.value);
          }}
          value={model.nonOwnershipDisclosure}
        />
      </label>
    </div>
  );
}

function StepThree({ model, change }: { model: WizardModel; change: Change }) {
  return (
    <div className={styles.stepBody}>
      <h2>Хранитель и верификация</h2>
      <div className={styles.fields}>
        <Field
          label="ID хранителя"
          onChange={(value) => {
            change('custodianId', value);
          }}
          value={model.custodianId}
        />
        <Field
          label="ID реестра расписок"
          onChange={(value) => {
            change('registryId', value);
          }}
          value={model.registryId}
        />
        <Field
          label="ID верификаторов через запятую"
          onChange={(value) => {
            change('verifierIds', value);
          }}
          value={model.verifierIds}
        />
      </div>
      <p className={styles.hint}>
        Интеграции выполняются через зарегистрированные источники и oracle gateway.
      </p>
    </div>
  );
}

function StepFour({ model, change }: { model: WizardModel; change: Change }) {
  return (
    <div className={styles.stepBody}>
      <h2>Экономика выпуска</h2>
      <div className={styles.fields}>
        <Field
          label="Начальный выпуск"
          onChange={(value) => {
            change('initialSupply', value);
          }}
          value={model.initialSupply}
        />
        <Field
          label="Цена выпуска в minor units"
          onChange={(value) => {
            change('issuePrice', value);
          }}
          value={model.issuePrice}
        />
        <Field
          label="Резерв обеспечения, %"
          onChange={(value) => {
            change('reservePercent', value);
          }}
          value={model.reservePercent}
        />
        <Field
          label="Плата за хранение в minor units"
          onChange={(value) => {
            change('storageFee', value);
          }}
          value={model.storageFee}
        />
        <Field
          label="Срок погашения"
          onChange={(value) => {
            change('maturityDate', value);
          }}
          type="date"
          value={model.maturityDate}
        />
      </div>
    </div>
  );
}

function StepFive({ model, change }: { model: WizardModel; change: Change }) {
  return (
    <div className={styles.stepBody}>
      <h2>Параметры торгов</h2>
      <div className={styles.fields}>
        <Field
          label="Тикер"
          onChange={(value) => {
            change('ticker', value.toUpperCase());
          }}
          value={model.ticker}
        />
        <Field
          label="Валюта"
          onChange={(value) => {
            change('currency', value.toUpperCase());
          }}
          value={model.currency}
        />
        <Field
          label="Шаг цены"
          onChange={(value) => {
            change('tickSize', value);
          }}
          value={model.tickSize}
        />
        <Field
          label="Торговый лот"
          onChange={(value) => {
            change('lotSize', value);
          }}
          value={model.lotSize}
        />
        <Field
          label="Минимальная заявка"
          onChange={(value) => {
            change('minimumOrderQuantity', value);
          }}
          value={model.minimumOrderQuantity}
        />
        <Field
          label="Минимальная физическая поставка"
          onChange={(value) => {
            change('minimumDeliveryQuantity', value);
          }}
          value={model.minimumDeliveryQuantity}
        />
      </div>
      <p className={styles.hint}>Расчёты: T+0. Параметры фиксируются паспортом выпуска.</p>
    </div>
  );
}

function ReviewStep({ model }: { model: WizardModel }) {
  return (
    <div className={styles.stepBody}>
      <h2>Паспорт токена и проверка</h2>
      <details open>
        <summary>1. Базовый актив</summary>
        <p>
          {model.commodity}, {model.grade}; {formatInteger(model.assetQuantity)} {model.unit};{' '}
          {model.storageLocation}
        </p>
      </details>
      <details>
        <summary>2. Права держателя</summary>
        <p>
          1 токен = право требования на {formatInteger(model.unitPerToken)} {model.unit}.{' '}
          {model.nonOwnershipDisclosure}
        </p>
      </details>
      <details>
        <summary>3. Хранитель и верификация</summary>
        <p>
          {model.custodianId}; реестр {model.registryId}; верификаторы {model.verifierIds}
        </p>
      </details>
      <details>
        <summary>4. Экономика</summary>
        <p>
          Выпуск {formatInteger(model.initialSupply)}; резерв {formatInteger(model.reservePercent)}
          %; maturity {model.maturityDate}
        </p>
      </details>
      <details>
        <summary>5. Торги</summary>
        <p>
          {model.ticker} / {model.currency}; лот {formatInteger(model.lotSize)}; поставка{' '}
          {formatInteger(model.minimumDeliveryQuantity)}
        </p>
      </details>
    </div>
  );
}

function CurrentStep({
  step,
  model,
  change,
}: {
  step: number;
  model: WizardModel;
  change: Change;
}) {
  if (step === 1) return <StepOne change={change} model={model} />;
  if (step === 2) return <StepTwo change={change} model={model} />;
  if (step === 3) return <StepThree change={change} model={model} />;
  if (step === 4) return <StepFour change={change} model={model} />;
  if (step === 5) return <StepFive change={change} model={model} />;
  return <ReviewStep model={model} />;
}

export function CreateTokenPage() {
  const [search] = useSearchParams();
  const editId = search.get('id') ?? '';
  const existing = useIssuerInstrument(editId);
  const commands = useDraftCommands();
  const navigate = useNavigate();
  const hydrated = useRef('');
  const [model, setModel] = useState<WizardModel>(() => initialWizardModel);
  const [step, setStep] = useState(1);
  const [instrumentId, setInstrumentId] = useState(editId);
  const [version, setVersion] = useState(1);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [apiError, setApiError] = useState<string>();

  useEffect(() => {
    if (existing.data !== undefined && hydrated.current !== existing.data.instrument.id) {
      hydrated.current = existing.data.instrument.id;
      setModel(modelFromIssue(existing.data));
      setVersion(existing.data.version);
      setInstrumentId(existing.data.instrument.id);
    }
  }, [existing.data]);

  const change: Change = (field, value) => {
    setModel((current) => ({ ...current, [field]: value }));
    setErrors([]);
    setApiError(undefined);
  };
  const checklist = completedSteps(model);
  const saving =
    commands.create.isPending || commands.update.isPending || commands.submit.isPending;

  const saveAndContinue = async () => {
    const validation = validateStep(model, step);
    setErrors(validation);
    if (validation.length !== 0) return;
    try {
      if (instrumentId.length === 0) {
        const created = await commands.create.mutateAsync(buildDraft(model));
        setInstrumentId(created.instrument.id);
        setVersion(created.version);
      } else {
        const updated = await commands.update.mutateAsync({
          id: instrumentId,
          draft: buildDraftUpdate(model, version),
        });
        setVersion(updated.version);
      }
      setStep((current) => Math.min(6, current + 1));
    } catch (caught) {
      setApiError(getUserErrorMessage(caught));
    }
  };

  const confirmSubmit = async () => {
    if (instrumentId.length === 0) return;
    try {
      const result = await commands.submit.mutateAsync({ id: instrumentId, version });
      setSubmitOpen(false);
      navigate(`/my-issues/${result.instrument.id}`);
    } catch (caught) {
      setSubmitOpen(false);
      setApiError(getUserErrorMessage(caught));
      if (caught instanceof ApiError && caught.code === 'PASSPORT_INCOMPLETE') {
        const target = caught.details
          .map((detail) =>
            detail.field === undefined ? undefined : missingFieldStep[detail.field],
          )
          .find((value) => value !== undefined);
        if (target !== undefined) setStep(target);
        setErrors(
          caught.details.map((detail) => `${detail.field ?? 'passport'}: ${detail.reason}`),
        );
      }
    }
  };

  return (
    <div className={styles.page}>
      <header>
        <p>Эмитент · Паспорт выпуска</p>
        <h1>Создание нового токена</h1>
        <span>Опишите базовый актив и права, которые представляет токен</span>
      </header>
      <nav aria-label="Шаги создания токена" className={styles.progress}>
        {steps.map((label, index) => {
          const number = index + 1;
          return (
            <button
              aria-current={step === number ? 'step' : undefined}
              className={checklist[index] ? styles.complete : ''}
              disabled={number > step && !checklist[index - 1]}
              key={label}
              onClick={() => {
                setStep(number);
              }}
              type="button"
            >
              <b>{checklist[index] ? '✓' : number}</b>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <div className={styles.layout}>
        <Card>
          <CurrentStep change={change} model={model} step={step} />
          {errors.length === 0 ? null : (
            <ul className={styles.errors} role="alert">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          {apiError === undefined ? null : (
            <p className={styles.apiError} role="alert">
              {apiError}
            </p>
          )}
          <div className={styles.actions}>
            {step > 1 ? (
              <Button
                disabled={saving}
                onClick={() => {
                  setStep((current) => current - 1);
                }}
                variant="secondary"
              >
                Назад
              </Button>
            ) : (
              <span />
            )}
            {step < 6 ? (
              <Button
                loading={saving}
                onClick={() => {
                  void saveAndContinue();
                }}
              >
                Сохранить и продолжить
              </Button>
            ) : (
              <Button
                disabled={readinessPercent(model) !== 100n}
                onClick={() => {
                  setSubmitOpen(true);
                }}
              >
                Подписать ЭЦП и отправить на листинг
              </Button>
            )}
          </div>
        </Card>
        <aside>
          <Card title="Черновик токена">
            <div className={styles.draft}>
              <span>Предлагаемый тикер</span>
              <strong>{model.ticker || '—'}</strong>
              <StatusBadge status="DRAFT" />
              <p>Версия паспорта: {version}</p>
              <div className={styles.readiness}>
                <b>{readinessPercent(model).toString()}%</b>
                <span>готово</span>
              </div>
              <ul>
                {steps.slice(0, 5).map((label, index) => (
                  <li className={checklist[index] ? styles.ready : ''} key={label}>
                    {checklist[index] ? '✓' : '○'} {label}
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        </aside>
      </div>
      {submitOpen ? (
        <div className={styles.backdrop}>
          <div
            aria-labelledby="esign-title"
            aria-modal="true"
            className={styles.dialog}
            role="dialog"
          >
            <h2 id="esign-title">Подписание ЭЦП</h2>
            <p>
              Интеграция с сервисом ЭЦП будет подключена позже. Сейчас будет отправлен
              подтверждённый паспорт версии {version}.
            </p>
            <div>
              <Button
                onClick={() => {
                  setSubmitOpen(false);
                }}
                variant="secondary"
              >
                Отмена
              </Button>
              <Button
                loading={commands.submit.isPending}
                onClick={() => {
                  void confirmSubmit();
                }}
              >
                Подписать и отправить
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

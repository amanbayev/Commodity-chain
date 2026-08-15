import { useRef, useState } from 'react';

import { getUserErrorMessage } from '../../../api/errors.js';
import { Button } from '../../../components/Button/Button.js';
import { formatInteger, formatMoney, multiplyIntegerStrings } from '../../../lib/integer-format.js';
import type { Order, OrderCreateRequest } from '../api/investorApi.js';
import styles from './OrderTicket.module.css';

interface CommandIdentity {
  clientOrderId: string;
  idempotencyKey: string;
}

export interface OrderTicketProps {
  currency: string;
  initialPrice?: string;
  instrumentId: string;
  lotSize: string;
  onSubmit: (request: { idempotencyKey: string; order: OrderCreateRequest }) => Promise<Order>;
}

function newCommandIdentity(): CommandIdentity {
  return { clientOrderId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
}

function positiveInteger(value: string): bigint | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  return BigInt(value);
}

export function OrderTicket({
  currency,
  initialPrice = '',
  instrumentId,
  lotSize,
  onSubmit,
}: OrderTicketProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [price, setPrice] = useState(initialPrice);
  const [quantity, setQuantity] = useState(lotSize);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Order>();
  const [submitting, setSubmitting] = useState(false);
  const identity = useRef<CommandIdentity | null>(null);

  const resetIdentity = () => {
    identity.current = newCommandIdentity();
    setResult(undefined);
  };

  const changeQuantity = (direction: -1 | 1) => {
    const step = positiveInteger(lotSize) ?? 1n;
    const current = positiveInteger(quantity) ?? 0n;
    const next = direction === 1 ? current + step : current > step ? current - step : step;
    setQuantity(next.toString());
    resetIdentity();
  };

  const total =
    positiveInteger(price) !== null && positiveInteger(quantity) !== null
      ? multiplyIntegerStrings(price, quantity)
      : null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    const numericPrice = positiveInteger(price);
    const numericQuantity = positiveInteger(quantity);
    const numericLot = positiveInteger(lotSize);
    if (numericPrice === null || numericQuantity === null) {
      setError('Цена и количество должны быть положительными целыми числами.');
      return;
    }
    if (numericLot === null || numericQuantity % numericLot !== 0n) {
      setError(`Количество должно быть кратно размеру лота ${formatInteger(lotSize)}.`);
      return;
    }
    if (!riskAccepted) {
      setError('Подтвердите ознакомление с паспортом токена и рисками.');
      return;
    }

    setSubmitting(true);
    try {
      const commandIdentity = identity.current ?? newCommandIdentity();
      identity.current = commandIdentity;
      const order = await onSubmit({
        idempotencyKey: commandIdentity.idempotencyKey,
        order: {
          clientOrderId: commandIdentity.clientOrderId,
          instrumentId,
          price,
          quantity,
          side,
          type: 'LIMIT',
        },
      });
      setResult(order);
    } catch (caught) {
      setError(getUserErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className={styles.ticket} onSubmit={handleSubmit}>
      <div className={styles.sideTabs}>
        <button
          aria-pressed={side === 'BUY'}
          className={side === 'BUY' ? styles.buyActive : ''}
          onClick={() => {
            setSide('BUY');
            resetIdentity();
          }}
          type="button"
        >
          Купить
        </button>
        <button
          aria-pressed={side === 'SELL'}
          className={side === 'SELL' ? styles.sellActive : ''}
          onClick={() => {
            setSide('SELL');
            resetIdentity();
          }}
          type="button"
        >
          Продать
        </button>
      </div>
      <label>
        Тип заявки
        <input disabled value="Лимитная" />
      </label>
      <label>
        Цена ({currency})
        <input
          aria-label="Цена"
          inputMode="numeric"
          onChange={(event) => {
            setPrice(event.target.value);
            resetIdentity();
          }}
          pattern="[0-9]+"
          value={price}
        />
      </label>
      <label>
        Количество токенов
        <span className={styles.stepper}>
          <button
            aria-label="Уменьшить количество"
            onClick={() => {
              changeQuantity(-1);
            }}
            type="button"
          >
            −
          </button>
          <input
            aria-label="Количество"
            inputMode="numeric"
            onChange={(event) => {
              setQuantity(event.target.value);
              resetIdentity();
            }}
            pattern="[0-9]+"
            value={quantity}
          />
          <button
            aria-label="Увеличить количество"
            onClick={() => {
              changeQuantity(1);
            }}
            type="button"
          >
            +
          </button>
        </span>
      </label>
      <div className={styles.calculation}>
        <span>Стоимость</span>
        <strong>{total === null ? '—' : formatMoney(total, currency)}</strong>
        <span>Комиссия</span>
        <span>Рассчитывается при исполнении</span>
      </div>
      <label className={styles.consent}>
        <input
          checked={riskAccepted}
          onChange={(event) => {
            setRiskAccepted(event.target.checked);
            resetIdentity();
          }}
          type="checkbox"
        />
        Я ознакомился с паспортом токена и рисками
      </label>
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {result === undefined ? null : (
        <p className={styles.success} role="status">
          Заявка принята: {result.id}
        </p>
      )}
      <Button loading={submitting} type="submit">
        {side === 'BUY' ? 'Купить' : 'Продать'} токены
      </Button>
    </form>
  );
}

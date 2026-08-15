import type { components } from './generated/schema.js';

export type ApiErrorCode = components['schemas']['ErrorCode'];
export type ApiErrorDetail = components['schemas']['ErrorDetail'];
export type ApiErrorResponse = components['schemas']['ErrorResponse'];

export const errorMessages = {
  AUTHENTICATION_REQUIRED: 'Требуется войти в систему.',
  COLLATERAL_INSUFFICIENT: 'Подтверждённого обеспечения недостаточно.',
  COLLATERAL_PROOF_INVALID: 'Подтверждение обеспечения недействительно.',
  CONFLICT: 'Операция конфликтует с текущим состоянием данных.',
  FOUR_EYES_REQUIRED: 'Требуется решение второго независимого оператора.',
  IDEMPOTENCY_KEY_REUSED: 'Ключ идемпотентности уже использован для другой операции.',
  INCOME_PROOF_INVALID: 'Подтверждение доходного события недействительно.',
  INSTRUMENT_NOT_TRADABLE: 'Инструмент сейчас недоступен для торгов.',
  INSTRUMENT_STATE_INVALID: 'Состояние инструмента не позволяет выполнить операцию.',
  INSUFFICIENT_FUNDS: 'Недостаточно доступных средств или токенов.',
  INTERNAL_ERROR: 'Внутренняя ошибка. Обратитесь в поддержку.',
  INVALID_STATUS: 'Текущий статус не позволяет выполнить операцию.',
  INVALID_TRANSITION: 'Недопустимый переход статуса.',
  MINT_ACCOUNT_NOT_CONFIGURED: 'Счёт выпуска инструмента не настроен.',
  ORACLE_EVENT_STALE: 'Событие оракула устарело.',
  ORACLE_NONCE_GAP: 'Обнаружен разрыв последовательности событий оракула.',
  ORACLE_NONCE_INVALID: 'Событие оракула уже обработано.',
  ORACLE_SIGNATURE_INVALID: 'Подпись источника не прошла проверку.',
  ORACLE_SOURCE_KEY_REVOKED: 'Ключ источника отозван.',
  ORACLE_SOURCE_UNKNOWN: 'Источник события не зарегистрирован.',
  ORDER_NOT_CANCELLABLE: 'Заявку больше нельзя отменить.',
  ORDER_REJECTED: 'Торговая заявка отклонена.',
  ORDER_TYPE_NOT_AVAILABLE: 'Этот тип заявки пока недоступен.',
  PARTICIPANT_NOT_FOUND: 'Участник не найден.',
  PASSPORT_INCOMPLETE: 'Паспорт токена заполнен не полностью.',
  PASSPORT_NOT_PUBLIC: 'Паспорт токена пока не опубликован.',
  PERMISSION_DENIED: 'Недостаточно прав для выполнения операции.',
  RATE_LIMITED: 'Слишком много запросов. Повторите позже.',
  REDEMPTION_DELIVERY_EXCEPTION: 'Срок исполнения погашения истёк.',
  REDEMPTION_LOT_INVALID: 'Количество не соответствует минимальной партии поставки.',
  REDEMPTION_NOT_ALLOWED: 'Погашение инструмента сейчас недоступно.',
  REDEMPTION_NOT_CANCELLABLE: 'Заявку на погашение больше нельзя отменить.',
  REDEMPTION_QUANTITY_MISMATCH: 'Количество отгруженного товара не совпадает с заявкой.',
  RESOURCE_NOT_FOUND: 'Запрошенный объект не найден.',
  SUPPLY_CAP_EXCEEDED: 'Выпуск превышает установленный лимит предложения.',
  SUPPLY_EXCEEDS_COLLATERAL: 'Выпуск превышает объём подтверждённого обеспечения.',
  VALIDATION_ERROR: 'Проверьте корректность заполненных данных.',
} satisfies Record<ApiErrorCode, string>;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly correlationId: string;
  readonly details: ApiErrorDetail[];
  readonly status: number;

  constructor(response: ApiErrorResponse, status: number) {
    super(response.message);
    this.name = 'ApiError';
    this.code = response.code;
    this.correlationId = response.correlationId;
    this.details = response.details;
    this.status = status;
  }
}

export function getUserErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return errorMessages[error.code];
  return 'Не удалось выполнить запрос. Проверьте соединение и повторите попытку.';
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ApiErrorResponse>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.correlationId === 'string' &&
    Array.isArray(candidate.details)
  );
}

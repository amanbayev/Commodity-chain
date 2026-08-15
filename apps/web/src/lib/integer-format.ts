const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/u;
const SIGNED_INTEGER = /^-?(0|[1-9][0-9]*)$/u;

export function parseUnsignedInteger(value: string, field = 'value'): bigint {
  if (!UNSIGNED_INTEGER.test(value))
    throw new TypeError(`${field} must be an unsigned integer string`);
  return BigInt(value);
}

export function parsePositiveInteger(value: string, field = 'value'): bigint {
  const parsed = parseUnsignedInteger(value, field);
  if (parsed === 0n) throw new TypeError(`${field} must be positive`);
  return parsed;
}

export function formatInteger(value: string | bigint): string {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (!SIGNED_INTEGER.test(text)) throw new TypeError('value must be an integer string');
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
  return `${negative ? '−' : ''}${grouped}`;
}

export function formatMoney(value: string | bigint, currency: string): string {
  const symbol = currency === 'KZT' ? '₸' : currency;
  return `${formatInteger(value)} ${symbol}`;
}

export function formatBasisPoints(value: string): string {
  if (!SIGNED_INTEGER.test(value)) throw new TypeError('basis points must be an integer string');
  const basisPoints = BigInt(value);
  const sign = basisPoints > 0n ? '+' : basisPoints < 0n ? '−' : '';
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0').replace(/0+$/u, '');
  return `${sign}${whole.toString()}${fraction.length === 0 ? '' : `,${fraction}`}%`;
}

export function multiplyIntegerStrings(left: string, right: string): string {
  return (parseUnsignedInteger(left, 'left') * parseUnsignedInteger(right, 'right')).toString();
}

export function subtractIntegerStrings(left: string, right: string): string {
  const result = parseUnsignedInteger(left, 'left') - parseUnsignedInteger(right, 'right');
  if (result < 0n) throw new RangeError('result must not be negative');
  return result.toString();
}

export function instrumentResponseToJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(instrumentResponseToJson);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, instrumentResponseToJson(entry)]),
  );
}

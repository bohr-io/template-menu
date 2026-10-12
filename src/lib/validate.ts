import { fail } from './http';

// Every input goes through one of these. A bad value answers 400 `invalid_<field>`.

type TextOptions = { max: number; min?: number; optional?: boolean; multiline?: boolean };

/** A trimmed string without control characters (new lines only when `multiline`); '' when optional and empty. */
export function text(value: unknown, field: string, options: TextOptions): string {
  if (value === undefined || value === null || value === '') {
    if (options.optional) return '';
    fail(400, `invalid_${field}`);
  }
  if (typeof value !== 'string') fail(400, `invalid_${field}`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters on purpose
  const cleaned = (options.multiline ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : value.replace(/[\u0000-\u001F\u007F]/g, ' ')).trim();
  if (cleaned === '' && options.optional) return '';
  if (cleaned.length < (options.min ?? 1) || cleaned.length > options.max) fail(400, `invalid_${field}`);
  return cleaned;
}

export function email(value: unknown, field = 'email', optional = false): string {
  const address = text(value, field, { max: 254, optional }).toLowerCase();
  if (address === '' && optional) return '';
  if (!/^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]{2,}$/.test(address)) fail(400, `invalid_${field}`);
  return address;
}

export function integer(value: unknown, field: string, min: number, max: number): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    fail(400, `invalid_${field}`);
  }
  return number;
}

export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(400, `invalid_${field}`);
  return value;
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(400, `invalid_${field}`);
  return value as T;
}

/** An absolute URL with one of `protocols` (http and https by default), so never javascript: or data:. */
export function url(value: unknown, field: string, options: { optional?: boolean; protocols?: string[] } = {}): string {
  const raw = text(value, field, { max: 2048, optional: options.optional });
  if (raw === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(400, `invalid_${field}`);
  }
  if (!(options.protocols ?? ['http:', 'https:']).includes(parsed.protocol)) fail(400, `invalid_${field}`);
  return parsed.href;
}

/** A positive integer id from the URL. */
export function id(value: string | undefined): number {
  if (value === undefined || !/^\d{1,12}$/.test(value)) fail(404, 'not_found');
  return Number(value);
}

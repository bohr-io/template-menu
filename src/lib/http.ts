import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env';

/** An error the client shows to the user: a short code (the page's dictionary has the text) and a status. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
  ) {
    super(code);
  }
}

export function fail(status: ContentfulStatusCode, code: string): never {
  throw new ApiError(status, code);
}

/** Answers `{ "error": "<code>" }`; unexpected errors are logged and answer `server_error`. */
export const onError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.code }, error.status);
  console.error(error);
  return c.json({ error: 'server_error' }, 500);
};

/**
 * API responses are never cached, and writes must be JSON: a cross-site page cannot send JSON with the
 * admin cookie (SameSite=Lax and no CORS), which keeps the admin safe from forged requests.
 */
export const apiGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) fail(415, 'json_required');
  }
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
};

/** The request's JSON object body, refusing bodies over `maxBytes`. */
export async function readJson(c: Context<AppEnv>, maxBytes = 32_768): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > maxBytes) fail(413, 'too_large');
  const text = await c.req.text();
  if (text.length > maxBytes) fail(413, 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(400, 'invalid_json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) fail(400, 'invalid_json');
  return body as Record<string, unknown>;
}

/** Everything that is not the API is a static file from public/ (or its 404 page). */
export const serveAssets: MiddlewareHandler<AppEnv> = (c) => c.env.ASSETS.fetch(c.req.raw);

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A cheap fixed-window limit per client address, kept in D1 (table rate_limits). Addresses are stored
 * hashed. Answers 429 `rate_limited` once `limit` requests of `bucket` happened in the window.
 */
export async function rateLimit(c: Context<AppEnv>, bucket: string, limit: number, windowSeconds: number) {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const key = `${bucket}:${(await sha256Hex(`rate:${ip}`)).slice(0, 24)}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (Math.random() < 0.02) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
        .bind(now - 86_400)
        .run()
        .catch(() => {}),
    );
  }
  if ((row?.count ?? 0) > limit) fail(429, 'rate_limited');
}

/** A CSV file (UTF-8 with BOM so spreadsheets read accents), safe against formula injection. */
export function csvResponse(filename: string, header: string[], rows: unknown[][]): Response {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const body = [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  return new Response(`﻿${body}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

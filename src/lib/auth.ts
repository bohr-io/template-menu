import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { fail, rateLimit, readJson } from './http';

// The admin is protected by one password, the ADMIN_PASSWORD variable (a Worker secret). After logging in,
// the browser keeps a session cookie signed with a key derived from that password: changing the password
// signs everybody out.

const COOKIE = 'admin_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

async function digest(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(text));
}

async function sessionKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await digest(`admin-session:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function createSession(password: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(password), encoder.encode(`admin.${expires}`));
  return `${expires}.${toBase64Url(signature)}`;
}

async function validSession(password: string, token: string | undefined): Promise<boolean> {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/.exec(token ?? '');
  if (!match?.[1] || !match[2] || Number(match[1]) < Date.now() / 1000) return false;
  const signature = fromBase64Url(match[2]);
  if (signature === null) return false;
  // HMAC verification compares in constant time
  return crypto.subtle.verify('HMAC', await sessionKey(password), signature, encoder.encode(`admin.${match[1]}`));
}

/** Compares in constant time (the digests have the same length whatever the inputs). */
async function samePassword(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The admin password, or 503 `admin_password_missing`: without it the admin stays closed. */
function adminPassword(env: AppEnv['Bindings']): string {
  const password = env.ADMIN_PASSWORD?.trim();
  if (!password) fail(503, 'admin_password_missing');
  return password;
}

export const auth = new Hono<AppEnv>()
  .get('/session', async (c) => {
    const password = adminPassword(c.env);
    return c.json({ authenticated: await validSession(password, getCookie(c, COOKIE)) });
  })
  .post('/login', async (c) => {
    const password = adminPassword(c.env);
    await rateLimit(c, 'login', 20, 15 * 60);
    const body = await readJson(c, 1024);
    const given = typeof body.password === 'string' ? body.password : '';
    if (given.length === 0 || given.length > 256 || !(await samePassword(given, password))) {
      fail(401, 'wrong_password');
    }
    setCookie(c, COOKIE, await createSession(password), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_SECONDS,
    });
    return c.json({ ok: true });
  })
  .post('/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    return c.json({ ok: true });
  });

/** Guards /api/admin/*: 503 without ADMIN_PASSWORD, 401 without a valid session. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const password = adminPassword(c.env);
  if (!(await validSession(password, getCookie(c, COOKIE)))) fail(401, 'unauthorized');
  await next();
};

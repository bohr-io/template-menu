// Small helpers shared by the pages: API calls, DOM building, messages, formatting and the admin login.
import { applyI18n, lang, t } from './i18n.js';

export { lang, t };

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** Calls the Worker API. Writes always send JSON (the server refuses anything else). */
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network_error');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON
  }
  if (!response.ok) throw new ApiError(response.status, data?.error ?? 'server_error', data);
  return data;
}

/** The user-facing text of an error code from the server. */
export function errorText(error) {
  const code = error?.code ?? 'server_error';
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? t('error.generic') : text;
}

/** Builds an element: h('a', { href, class: 'btn', onclick }, 'text', child). Text is never parsed as HTML. */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'value' || key === 'checked' || key === 'selected') element[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

export const $ = (selector, root = document) => root.querySelector(selector);

/** A short message at the corner of the screen, also read by screen readers. */
export function toast(message, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const item = h('div', { class: `toast ${kind}` }, message);
  box.append(item);
  setTimeout(() => item.remove(), 4000);
}

/** Runs `task` with `button` disabled; shows the error as a toast. Returns the task's result (or undefined). */
export async function busy(button, task) {
  if (button) button.disabled = true;
  try {
    return await task();
  } catch (error) {
    // The admin session ended: back to the login
    if (error?.code === 'unauthorized') location.reload();
    else toast(errorText(error), 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/** The values of a form's named fields; checkboxes become booleans. */
export function formValues(form) {
  const values = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === 'checkbox') values[element.name] = element.checked;
    else if (element.type === 'radio') {
      if (element.checked) values[element.name] = element.value;
    } else values[element.name] = element.value;
  }
  return values;
}

export function formatNumber(value) {
  return new Intl.NumberFormat(lang).format(value);
}

export function formatMoney(cents, currency = 'BRL') {
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

/** A date and time from an ISO string (UTC), in the visitor's time zone. */
export function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Applies the dictionary to the page and shows it (the page is hidden until its texts are in place). */
export function ready() {
  applyI18n();
  document.documentElement.classList.add('ready');
}

/**
 * The admin entrance: shows #setup when ADMIN_PASSWORD is not set, #login until the password is right,
 * then #admin and calls `start()`. The logout button (#logout) ends the session.
 */
export async function adminGate(start) {
  ready();
  const show = (id) => {
    for (const section of ['setup', 'login', 'admin']) document.getElementById(section).hidden = section !== id;
  };
  let session;
  try {
    session = await api('/api/auth/session');
  } catch (error) {
    if (error.code === 'admin_password_missing') return show('setup');
    show('login');
    $('#login-error').textContent = errorText(error);
    $('#login-error').hidden = false;
    return;
  }
  $('#logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
  if (session.authenticated) {
    show('admin');
    return start();
  }
  show('login');
  const form = $('#login-form');
  // The first input is the hidden username (for password managers): focus the password
  form.elements.password?.focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#login-error');
    error.hidden = true;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: { password: form.password.value } });
      form.reset();
      show('admin');
      await start();
    } catch (failure) {
      error.textContent = errorText(failure);
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

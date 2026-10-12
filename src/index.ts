import { Hono } from 'hono';
import type { AppEnv } from './env';
import { auth, requireAdmin } from './lib/auth';
import { apiGuard, csvResponse, fail, onError, rateLimit, readJson, serveAssets } from './lib/http';
import { boolean, id, integer, oneOf, text, url } from './lib/validate';

// ---------------------------------------------------------------------------------------------------------
// Settings

/** Currencies the admin can pick. All of them have 2 decimal places, so "cents" always means 1/100. */
const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'MXN', 'COP', 'PEN', 'UYU', 'BOB', 'CAD', 'AUD'] as const;

type Settings = {
  store_name: string;
  store_description: string;
  /** Digits only, with the country code (5511987654321), or '' when not set yet. */
  whatsapp: string;
  currency: (typeof CURRENCIES)[number];
  delivery_enabled: boolean;
  delivery_fee_cents: number;
  min_order_cents: number;
  open: boolean;
};

async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(results.map((row) => [row.key, row.value]));
  const currency = map.get('currency') ?? 'BRL';
  return {
    store_name: map.get('store_name') ?? '',
    store_description: map.get('store_description') ?? '',
    whatsapp: map.get('whatsapp') ?? '',
    currency: (CURRENCIES as readonly string[]).includes(currency) ? (currency as Settings['currency']) : 'BRL',
    delivery_enabled: map.get('delivery_enabled') === '1',
    delivery_fee_cents: Number(map.get('delivery_fee_cents') ?? 0) || 0,
    min_order_cents: Number(map.get('min_order_cents') ?? 0) || 0,
    open: map.get('open') === '1',
  };
}

/** A WhatsApp number as wa.me wants it: digits with the country code, 10 to 15 of them ('' allowed). */
function whatsappNumber(value: unknown): string {
  const raw = text(value, 'whatsapp', { max: 30, optional: true });
  const digits = raw.replace(/[\s+()\-.]/g, '');
  if (digits !== '' && !/^\d{10,15}$/.test(digits)) fail(400, 'invalid_whatsapp');
  return digits;
}

// ---------------------------------------------------------------------------------------------------------
// Menu

type Category = { id: number; name: string; position: number; visible: number };
type Item = {
  id: number;
  category_id: number;
  name: string;
  description: string;
  price_cents: number;
  photo_url: string;
  available: number;
  position: number;
};

const MAX_PRICE_CENTS = 10_000_000;

function categoryInput(body: Record<string, unknown>) {
  return { name: text(body.name, 'name', { max: 60 }), visible: boolean(body.visible, 'visible') };
}

async function itemInput(db: D1Database, body: Record<string, unknown>) {
  const item = {
    category_id: integer(body.category_id, 'category_id', 1, 1e12),
    name: text(body.name, 'name', { max: 100 }),
    description: text(body.description, 'description', { max: 500, optional: true, multiline: true }),
    price_cents: integer(body.price_cents, 'price_cents', 0, MAX_PRICE_CENTS),
    photo_url: url(body.photo_url, 'photo_url', { optional: true, protocols: ['https:'] }),
    available: boolean(body.available, 'available'),
  };
  const exists = await db.prepare('SELECT 1 AS found FROM categories WHERE id = ?').bind(item.category_id).first('found');
  if (exists === null) fail(400, 'invalid_category_id');
  return item;
}

/**
 * Moves a category (or an item inside its category) one place up or down. Positions are rewritten as
 * 0, 1, 2… for the whole group, which also repairs ties left by older data.
 */
async function move(db: D1Database, table: 'categories' | 'items', rowId: number, direction: 'up' | 'down') {
  let siblings: number[];
  if (table === 'categories') {
    siblings = (await db.prepare('SELECT id FROM categories ORDER BY position, id').all<{ id: number }>()).results.map((row) => row.id);
  } else {
    const categoryId = await db.prepare('SELECT category_id FROM items WHERE id = ?').bind(rowId).first<number>('category_id');
    if (categoryId === null) fail(404, 'not_found');
    siblings = (
      await db.prepare('SELECT id FROM items WHERE category_id = ? ORDER BY position, id').bind(categoryId).all<{ id: number }>()
    ).results.map((row) => row.id);
  }
  const index = siblings.indexOf(rowId);
  if (index === -1) fail(404, 'not_found');
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= siblings.length) return;
  [siblings[index], siblings[target]] = [siblings[target] as number, rowId];
  await db.batch(siblings.map((siblingId, position) => db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).bind(position, siblingId)));
}

// ---------------------------------------------------------------------------------------------------------
// Orders

const MAX_QTY = 99;
const MAX_LINES = 50;
const STATUSES = ['new', 'done', 'cancelled'] as const;

type OrderLine = { id: number; name: string; price_cents: number; qty: number; line_cents: number };

/** The cart sent by the page: [{ id, qty }], 1 to 50 lines, 1 to 99 of each; repeated ids are merged. */
function cartLines(value: unknown): { id: number; qty: number }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINES) fail(400, 'invalid_items');
  const merged = new Map<number, number>();
  for (const line of value) {
    if (typeof line !== 'object' || line === null) fail(400, 'invalid_items');
    const { id: itemId, qty } = line as Record<string, unknown>;
    const key = integer(itemId, 'items', 1, 1e12);
    merged.set(key, Math.min(MAX_QTY, (merged.get(key) ?? 0) + integer(qty, 'items', 1, MAX_QTY)));
  }
  return [...merged].map(([itemId, qty]) => ({ id: itemId, qty }));
}

/** A short order code people can read over the phone (no 0/O, 1/I/L). */
function orderCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => alphabet.charAt(byte % alphabet.length)).join('');
}

function parseLines(json: string): OrderLine[] {
  try {
    const lines: unknown = JSON.parse(json);
    return Array.isArray(lines) ? (lines as OrderLine[]) : [];
  } catch {
    return [];
  }
}

/** Start of "today" for the stats: the admin sends its local midnight (ISO); defaults to UTC midnight. */
function sinceParam(value: string | undefined): string {
  if (value === undefined || value === '') return `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) fail(400, 'invalid_since');
  // Same shape as created_at so the text comparison in SQL is right
  return `${date.toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------------------------------------------------
// Routes

const app = new Hono<AppEnv>();
app.onError(onError);
app.use('/api/*', apiGuard);
app.route('/api/auth', auth);
app.use('/api/admin/*', requireAdmin);

// Public: the store and its visible categories with their items (unavailable items included, marked)
app.get('/api/menu', async (c) => {
  const [settings, categories, items] = await Promise.all([
    loadSettings(c.env.DB),
    c.env.DB.prepare('SELECT id, name FROM categories WHERE visible = 1 ORDER BY position, id').all<Pick<Category, 'id' | 'name'>>(),
    c.env.DB.prepare(
      `SELECT i.id, i.category_id, i.name, i.description, i.price_cents, i.photo_url, i.available
       FROM items i JOIN categories c ON c.id = i.category_id
       WHERE c.visible = 1 ORDER BY i.position, i.id`,
    ).all<Omit<Item, 'position'>>(),
  ]);
  const { whatsapp, ...store } = settings;
  return c.json({
    store: { ...store, has_whatsapp: whatsapp !== '' },
    categories: categories.results.map((category) => ({
      ...category,
      items: items.results
        .filter((item) => item.category_id === category.id)
        .map(({ category_id: _, ...item }) => ({ ...item, available: item.available === 1 })),
    })),
  });
});

// Public: place an order. Prices, fee and total are computed here from D1; the page's numbers are ignored.
app.post('/api/orders', async (c) => {
  const body = await readJson(c, 16_384);
  // Bots fill the hidden "website" field: they get an answer that looks fine and nothing is stored
  if (typeof body.website === 'string' && body.website !== '') {
    return c.json({ code: '', items: [], subtotal_cents: 0, fee_cents: 0, total_cents: 0, whatsapp: '' }, 201);
  }
  // Generous: many phones share one address (carrier NAT), and failed attempts count too
  await rateLimit(c, 'order', 30, 10 * 60);
  const settings = await loadSettings(c.env.DB);
  if (!settings.open) fail(409, 'store_closed');
  if (settings.whatsapp === '') fail(409, 'whatsapp_missing');

  const fulfillment = oneOf(body.fulfillment, 'fulfillment', ['pickup', 'delivery'] as const);
  if (fulfillment === 'delivery' && !settings.delivery_enabled) fail(409, 'delivery_unavailable');
  const order = {
    customer_name: text(body.name, 'name', { max: 100, min: 2 }),
    phone: text(body.phone, 'phone', { max: 30, optional: true }),
    address: fulfillment === 'delivery' ? text(body.address, 'address', { max: 300, min: 5, multiline: true }) : '',
    note: text(body.note, 'note', { max: 500, optional: true, multiline: true }),
  };
  if (order.phone !== '' && !/^[0-9+()\-.\s]{6,30}$/.test(order.phone)) fail(400, 'invalid_phone');
  const cart = cartLines(body.items);

  // Reload every item from D1: it must exist, be available and sit in a visible category
  const placeholders = cart.map(() => '?').join(', ');
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.name, i.price_cents FROM items i JOIN categories c ON c.id = i.category_id
     WHERE i.available = 1 AND c.visible = 1 AND i.id IN (${placeholders})`,
  )
    .bind(...cart.map((line) => line.id))
    .all<Pick<Item, 'id' | 'name' | 'price_cents'>>();
  const found = new Map(results.map((item) => [item.id, item]));
  const missing = cart.filter((line) => !found.has(line.id)).map((line) => line.id);
  if (missing.length > 0) return c.json({ error: 'item_unavailable', items: missing }, 409);

  const lines: OrderLine[] = cart.map(({ id: itemId, qty }) => {
    const item = found.get(itemId) as Pick<Item, 'id' | 'name' | 'price_cents'>;
    return { id: itemId, name: item.name, price_cents: item.price_cents, qty, line_cents: item.price_cents * qty };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.line_cents, 0);
  if (subtotal < settings.min_order_cents) {
    return c.json({ error: 'below_minimum', min_order_cents: settings.min_order_cents }, 409);
  }
  const fee = fulfillment === 'delivery' ? settings.delivery_fee_cents : 0;
  const total = subtotal + fee;

  // The code is random; on the rare clash with an older order, draw another one
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = orderCode();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO orders (code, customer_name, phone, fulfillment, address, note, items, subtotal_cents, fee_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING RETURNING id`,
    )
      .bind(code, order.customer_name, order.phone, fulfillment, order.address, order.note, JSON.stringify(lines), subtotal, fee, total)
      .first<number>('id');
    if (inserted !== null) {
      return c.json({ code, items: lines, subtotal_cents: subtotal, fee_cents: fee, total_cents: total, whatsapp: settings.whatsapp }, 201);
    }
  }
  throw new Error('Could not draw a free order code');
});

// Admin: orders, newest first, optionally of one status
app.get('/api/admin/orders', async (c) => {
  const status = c.req.query('status') ? oneOf(c.req.query('status'), 'status', STATUSES) : '';
  const page = integer(c.req.query('page') ?? '1', 'page', 1, 100_000);
  const pageSize = 30;
  const where = status === '' ? '' : 'WHERE status = ?';
  const binds = status === '' ? [] : [status];
  const [rows, total] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`).bind(...binds),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM orders ${where}`).bind(...binds),
  ]);
  const items = (rows?.results ?? []).map((row) => ({ ...row, items: parseLines(String(row.items)) }));
  return c.json({ items, total: Number(total?.results[0]?.total ?? 0), page, pageSize });
});

// Admin: orders and revenue since the admin's midnight (cancelled orders don't count), orders still open and
// the newest order id (the admin compares it to tell when new orders arrive)
app.get('/api/admin/stats', async (c) => {
  const since = sinceParam(c.req.query('since'));
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(created_at >= ?1 AND status != 'cancelled'), 0) AS today,
       COALESCE(SUM(CASE WHEN created_at >= ?1 AND status != 'cancelled' THEN total_cents ELSE 0 END), 0) AS revenue_today,
       COALESCE(SUM(status = 'new'), 0) AS pending,
       COALESCE(MAX(id), 0) AS latest_id
     FROM orders`,
  )
    .bind(since)
    .first<{ today: number; revenue_today: number; pending: number; latest_id: number }>();
  const settings = await loadSettings(c.env.DB);
  return c.json({ ...(row ?? { today: 0, revenue_today: 0, pending: 0, latest_id: 0 }), currency: settings.currency });
});

app.patch('/api/admin/orders/:id', async (c) => {
  const body = await readJson(c, 1024);
  const status = oneOf(body.status, 'status', STATUSES);
  const result = await c.env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, id(c.req.param('id'))).run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

app.get('/api/admin/orders.csv', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM orders ORDER BY id').all<Record<string, unknown>>();
  const money = (cents: unknown) => (Number(cents) / 100).toFixed(2);
  const columns = ['code', 'created_at', 'status', 'customer_name', 'phone', 'fulfillment', 'address', 'note'];
  return csvResponse(
    'orders.csv',
    [...columns, 'items', 'subtotal', 'fee', 'total'],
    results.map((row) => [
      ...columns.map((column) => row[column]),
      parseLines(String(row.items))
        .map((line) => `${line.qty}x ${line.name}`)
        .join('; '),
      money(row.subtotal_cents),
      money(row.fee_cents),
      money(row.total_cents),
    ]),
  );
});

// Admin: the whole menu (hidden categories and unavailable items too)
app.get('/api/admin/menu', async (c) => {
  const [categories, items] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM categories ORDER BY position, id'),
    c.env.DB.prepare('SELECT * FROM items ORDER BY position, id'),
  ]);
  return c.json({
    categories: ((categories?.results ?? []) as Category[]).map((category) => ({ ...category, visible: category.visible === 1 })),
    items: ((items?.results ?? []) as Item[]).map((item) => ({ ...item, available: item.available === 1 })),
  });
});

app.post('/api/admin/categories', async (c) => {
  const category = categoryInput(await readJson(c));
  const created = await c.env.DB.prepare(
    `INSERT INTO categories (name, visible, position)
     VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM categories)) RETURNING id`,
  )
    .bind(category.name, category.visible ? 1 : 0)
    .first<number>('id');
  return c.json({ id: created }, 201);
});

app.put('/api/admin/categories/:id', async (c) => {
  const category = categoryInput(await readJson(c));
  const result = await c.env.DB.prepare('UPDATE categories SET name = ?, visible = ? WHERE id = ?')
    .bind(category.name, category.visible ? 1 : 0, id(c.req.param('id')))
    .run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

// A category with items can't be deleted: move or delete its items first
app.delete('/api/admin/categories/:id', async (c) => {
  const categoryId = id(c.req.param('id'));
  const items = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM items WHERE category_id = ?').bind(categoryId).first<number>('total');
  if ((items ?? 0) > 0) fail(409, 'category_not_empty');
  const result = await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(categoryId).run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

app.post('/api/admin/categories/:id/move', async (c) => {
  const direction = oneOf((await readJson(c, 1024)).direction, 'direction', ['up', 'down'] as const);
  await move(c.env.DB, 'categories', id(c.req.param('id')), direction);
  return c.json({ ok: true });
});

app.post('/api/admin/items', async (c) => {
  const item = await itemInput(c.env.DB, await readJson(c));
  const created = await c.env.DB.prepare(
    `INSERT INTO items (category_id, name, description, price_cents, photo_url, available, position)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE category_id = ?1)) RETURNING id`,
  )
    .bind(item.category_id, item.name, item.description, item.price_cents, item.photo_url, item.available ? 1 : 0)
    .first<number>('id');
  return c.json({ id: created }, 201);
});

// Updates an item; moving it to another category puts it at the end of that category
app.put('/api/admin/items/:id', async (c) => {
  const itemId = id(c.req.param('id'));
  const item = await itemInput(c.env.DB, await readJson(c));
  const result = await c.env.DB.prepare(
    `UPDATE items SET name = ?2, description = ?3, price_cents = ?4, photo_url = ?5, available = ?6,
       position = CASE WHEN category_id = ?7 THEN position
         ELSE (SELECT COALESCE(MAX(position), -1) + 1 FROM items WHERE category_id = ?7) END,
       category_id = ?7
     WHERE id = ?1`,
  )
    .bind(itemId, item.name, item.description, item.price_cents, item.photo_url, item.available ? 1 : 0, item.category_id)
    .run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

app.delete('/api/admin/items/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id(c.req.param('id'))).run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

app.post('/api/admin/items/:id/move', async (c) => {
  const direction = oneOf((await readJson(c, 1024)).direction, 'direction', ['up', 'down'] as const);
  await move(c.env.DB, 'items', id(c.req.param('id')), direction);
  return c.json({ ok: true });
});

app.get('/api/admin/settings', async (c) => c.json({ ...(await loadSettings(c.env.DB)), currencies: CURRENCIES }));

app.put('/api/admin/settings', async (c) => {
  const body = await readJson(c);
  const settings: Record<keyof Settings, string> = {
    store_name: text(body.store_name, 'store_name', { max: 80, optional: true }),
    store_description: text(body.store_description, 'store_description', { max: 300, optional: true, multiline: true }),
    whatsapp: whatsappNumber(body.whatsapp),
    currency: oneOf(body.currency, 'currency', CURRENCIES),
    delivery_enabled: boolean(body.delivery_enabled, 'delivery_enabled') ? '1' : '0',
    delivery_fee_cents: String(integer(body.delivery_fee_cents, 'delivery_fee_cents', 0, 1_000_000)),
    min_order_cents: String(integer(body.min_order_cents, 'min_order_cents', 0, MAX_PRICE_CENTS)),
    open: boolean(body.open, 'open') ? '1' : '0',
  };
  await c.env.DB.batch(
    Object.entries(settings).map(([key, value]) =>
      c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(
        key,
        value,
      ),
    ),
  );
  return c.json({ ...(await loadSettings(c.env.DB)), currencies: CURRENCIES });
});

app.all('/api/*', () => fail(404, 'not_found'));
app.all('*', serveAssets);

export default app;

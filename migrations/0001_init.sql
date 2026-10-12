-- Menu: categories, items, orders, store settings and the request limiter.

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1
);

-- Prices are integers in cents (1990 = 19.90). photo_url is an https address or ''.
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  photo_url TEXT NOT NULL DEFAULT '',
  available INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX items_category ON items (category_id, position);

-- items is a JSON snapshot taken when the order was placed: [{ id, name, price_cents, qty, line_cents }],
-- so later menu changes never rewrite old orders.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX orders_created_at ON orders (created_at);
CREATE INDEX orders_status ON orders (status, id);

-- Store settings the owner edits in the admin; an empty store name or description shows the default text.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('store_name', ''),
  ('store_description', ''),
  ('whatsapp', ''),
  ('currency', 'BRL'),
  ('delivery_enabled', '1'),
  ('delivery_fee_cents', '600'),
  ('min_order_cents', '2000'),
  ('open', '1');

-- Sample menu so the page looks alive on first open (edit or delete it in the admin).
INSERT INTO categories (id, name, position, visible) VALUES
  (1, 'Lanches', 0, 1),
  (2, 'Bebidas', 1, 1),
  (3, 'Sobremesas', 2, 1);

INSERT INTO items (category_id, name, description, price_cents, available, position) VALUES
  (1, 'Hambúrguer artesanal', 'Pão brioche, hambúrguer de 150 g, queijo, alface, tomate e molho da casa.', 3290, 1, 0),
  (1, 'Misto quente', 'Pão de forma na chapa com presunto e queijo derretido.', 1400, 1, 1),
  (1, 'Pão de queijo (6 unidades)', 'Quentinho, saído do forno.', 1200, 1, 2),
  (1, 'Sanduíche natural', 'Pão integral, frango desfiado, cenoura, alface e requeijão.', 1850, 1, 3),
  (2, 'Café espresso', 'Grãos especiais, extração curta.', 700, 1, 0),
  (2, 'Suco de laranja (400 ml)', 'Natural, espremido na hora.', 1200, 1, 1),
  (2, 'Refrigerante lata', 'Consulte os sabores.', 750, 0, 2),
  (3, 'Brownie com sorvete', 'Brownie de chocolate meio amargo com uma bola de sorvete de creme.', 1990, 1, 0),
  (3, 'Bolo de cenoura (fatia)', 'Com cobertura de chocolate.', 1100, 1, 1);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

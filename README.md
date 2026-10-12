# Menu

A digital menu for a restaurant, bakery or small shop. Customers browse the categories, add items to a cart
(kept in their browser) and place the order: it is saved, and they send it to the store on WhatsApp with one tap,
already written (order code, items, fee, total, pickup or delivery address, notes). The admin follows the orders
(stats for today, filters, mark done or cancel, CSV export, refreshes every 30 seconds), edits the menu (categories
and items, prices, photos by URL, availability, order on the page) and the store settings (name, WhatsApp number,
currency, delivery fee, minimum order, open or closed).

The server never trusts the page: it reloads every item from the database, refuses unavailable ones, recomputes
prices, fee and total, and checks the minimum order and that the store is open.

Runs as one Cloudflare Worker (Hono API + static files in `public/`) with a D1 database. The page speaks
Brazilian Portuguese, English and Spanish, following the visitor's browser. The sample menu (3 categories,
9 items) is there so the page looks alive: edit or delete it in the admin, and set the WhatsApp number in
Settings, since orders stay off until it is set.

## Admin password

The admin (`/admin`) uses the `ADMIN_PASSWORD` variable. bohr sets it when it creates the project; to change it,
edit the site variable in bohr or run `npx wrangler secret put ADMIN_PASSWORD`. Without it the admin stays
closed and explains how to set it.

## Routes

| Route | What |
| --- | --- |
| `/` | The menu, the cart and the checkout |
| `/admin` | Admin: orders, menu editor, settings |
| `GET /api/menu` | Store settings (without the WhatsApp number) and visible categories with their items |
| `POST /api/orders` | Place an order: `{ name, phone?, fulfillment: "pickup" \| "delivery", address?, note?, items: [{ id, qty }] }` → `{ code, items, subtotal_cents, fee_cents, total_cents, whatsapp }` (409 `item_unavailable` with `items`, `below_minimum`, `store_closed`, `whatsapp_missing`, `delivery_unavailable`) |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | Admin session |
| `GET /api/admin/orders?status=&page=` | Orders, newest first |
| `PATCH /api/admin/orders/:id` | `{ status: "new" \| "done" \| "cancelled" }` |
| `GET /api/admin/orders.csv` | CSV export |
| `GET /api/admin/stats?since=` | Orders and revenue since `since` (the admin's midnight), open orders |
| `GET /api/admin/menu` | All categories and items |
| `POST /api/admin/categories`, `PUT/DELETE /api/admin/categories/:id` | Categories (`{ name, visible }`; a category with items can't be deleted) |
| `POST /api/admin/items`, `PUT/DELETE /api/admin/items/:id` | Items (`{ category_id, name, description, price_cents, photo_url, available }`) |
| `POST /api/admin/categories/:id/move`, `POST /api/admin/items/:id/move` | `{ direction: "up" \| "down" }` |
| `GET/PUT /api/admin/settings` | Store name and description, WhatsApp, currency, delivery, minimum order, open |

Money is stored as integer cents; the currencies offered all have 2 decimal places.

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # sets ADMIN_PASSWORD for local development
npx wrangler d1 migrations apply DB --local && npx wrangler dev
```

Schema changes go in a new file in `migrations/` (for example `0002_add_item_options.sql`); deploys apply them.

## Ideas to ask the agent

- Take payment online when the order is placed (Pix, Mercado Pago or Stripe) and mark the order as paid.
- Delivery areas (neighborhoods or distance) with a different fee for each one.
- Opening hours per weekday that open and close the store automatically.
- Item options and add-ons (size, extra cheese, no onions) with their own prices.
- A printer-friendly view of each order for the kitchen.
- Upload item photos to R2 instead of pasting a link.

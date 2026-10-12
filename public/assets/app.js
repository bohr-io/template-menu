// The public menu: categories and items, the cart (kept in this browser) and the checkout through WhatsApp.
import { $, api, errorText, formatMoney, formValues, h, ready, t } from './ui.js';

const CART_KEY = 'menu-cart';
const MAX_QTY = 99;
const MAX_LINES = 50;

const state = {
  store: null,
  categories: [],
  /** Every item on the page by id. */
  items: new Map(),
  /** The cart: item id → quantity. Prices always come from the menu (and the server recomputes them). */
  cart: new Map(),
  /** The +/− controls of each item card, to update them in place. */
  controls: new Map(),
};

const dialog = $('#cart');
const form = $('#checkout');
const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
document.body.append(live);

const money = (cents) => formatMoney(cents, state.store?.currency ?? 'BRL');
const storeName = () => state.store?.store_name || t('store.defaultName');

// ---------------------------------------------------------------------------------------------------------
// Cart storage (validated on load: the browser's storage is not trusted)

function loadCart() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(CART_KEY) ?? '[]');
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) return;
  for (const line of saved.slice(0, MAX_LINES)) {
    const id = Number(line?.id);
    const qty = Number(line?.qty);
    if (Number.isInteger(id) && id > 0 && Number.isInteger(qty) && qty > 0) state.cart.set(id, Math.min(qty, MAX_QTY));
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...state.cart].map(([id, qty]) => ({ id, qty }))));
  } catch {
    // Private mode or storage full: the cart just won't survive a reload
  }
}

/** Drops cart lines whose item is gone or unavailable. Returns how many were dropped. */
function pruneCart() {
  let removed = 0;
  for (const id of [...state.cart.keys()]) {
    if (!state.items.get(id)?.available) {
      state.cart.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) saveCart();
  return removed;
}

function setQty(id, qty) {
  const item = state.items.get(id);
  if (!item) return;
  const next = Math.max(0, Math.min(MAX_QTY, qty));
  if (next === 0) state.cart.delete(id);
  else if (state.cart.has(id) || state.cart.size < MAX_LINES) state.cart.set(id, next);
  saveCart();
  updateControl(id);
  renderCart();
  live.textContent = t('item.quantity', { name: item.name, qty: state.cart.get(id) ?? 0 });
}

function subtotal() {
  let sum = 0;
  for (const [id, qty] of state.cart) sum += (state.items.get(id)?.price_cents ?? 0) * qty;
  return sum;
}

function cartCount() {
  let count = 0;
  for (const qty of state.cart.values()) count += qty;
  return count;
}

// ---------------------------------------------------------------------------------------------------------
// Store header and menu

function renderStore() {
  const store = state.store;
  document.title = storeName();
  $('#store-name').textContent = storeName();
  $('#store-description').textContent = store.store_description || t('store.defaultDescription');
  $('#store-mark').textContent = ([...storeName().trim()][0] ?? '•').toUpperCase();
  const info = [
    h('li', { class: `pill ${store.open ? 'open' : 'closed'}` }, store.open ? t('store.open') : t('store.closed')),
    h(
      'li',
      { class: 'pill' },
      !store.delivery_enabled
        ? t('store.pickupOnly')
        : store.delivery_fee_cents > 0
          ? t('store.deliveryFee', { fee: money(store.delivery_fee_cents) })
          : t('store.deliveryFree'),
    ),
    store.min_order_cents > 0 ? h('li', { class: 'pill' }, t('store.minimum', { amount: money(store.min_order_cents) })) : null,
  ];
  $('#store-info').replaceChildren(...info.filter(Boolean));
  $('#closed-notice').hidden = store.open;
  $('#choice-delivery').hidden = !store.delivery_enabled;
  if (!store.delivery_enabled) form.elements.fulfillment.value = 'pickup';
}

/** A colored tile with the item's initial, used when there is no photo (or it fails to load). */
function placeholder(item) {
  const tile = h('div', { class: 'item-photo placeholder', 'aria-hidden': 'true' }, ([...item.name.trim()][0] ?? '•').toUpperCase());
  tile.style.setProperty('--hue', String([18, 32, 45, 140, 195, 340][item.id % 6]));
  return tile;
}

function itemControl(item) {
  const add = h('button', {
    class: 'btn primary small add-btn',
    type: 'button',
    'aria-label': t('item.addLabel', { name: item.name }),
    onclick: () => {
      setQty(item.id, 1);
      plus.focus();
    },
    text: `+ ${t('item.add')}`,
  });
  const minus = h('button', {
    class: 'step-btn',
    type: 'button',
    'aria-label': t('item.decrease', { name: item.name }),
    onclick: () => {
      const next = (state.cart.get(item.id) ?? 0) - 1;
      setQty(item.id, next);
      if (next <= 0) add.focus();
    },
    text: '−',
  });
  const plus = h('button', {
    class: 'step-btn',
    type: 'button',
    'aria-label': t('item.increase', { name: item.name }),
    onclick: () => setQty(item.id, (state.cart.get(item.id) ?? 0) + 1),
    text: '+',
  });
  const count = h('span', { class: 'step-count' });
  const stepper = h('div', { class: 'stepper' }, minus, count, plus);
  state.controls.set(item.id, { add, stepper, count, plus });
  return h('div', { class: 'item-control' }, add, stepper);
}

function updateControl(id) {
  const control = state.controls.get(id);
  if (!control) return;
  const qty = state.cart.get(id) ?? 0;
  control.add.hidden = qty > 0;
  control.stepper.hidden = qty === 0;
  control.count.textContent = String(qty);
  control.plus.disabled = qty >= MAX_QTY;
}

function itemCard(item) {
  const titleId = `item-${item.id}-name`;
  const media = item.photo_url
    ? h('img', {
        class: 'item-photo',
        src: item.photo_url,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        onerror: (event) => event.currentTarget.replaceWith(placeholder(item)),
      })
    : placeholder(item);
  return h(
    'article',
    { class: `item-card${item.available ? '' : ' unavailable'}`, 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'item-info' },
      h('h3', { id: titleId }, item.name),
      item.description ? h('p', { class: 'item-description' }, item.description) : null,
      h(
        'div',
        { class: 'item-foot' },
        h('span', { class: 'price' }, money(item.price_cents)),
        item.available ? itemControl(item) : h('span', { class: 'badge' }, t('item.unavailable')),
      ),
    ),
    media,
  );
}

function renderMenu() {
  state.controls.clear();
  const categories = state.categories.filter((category) => category.items.length > 0);
  $('#sections').replaceChildren(
    ...categories.map((category) =>
      h(
        'section',
        { class: 'menu-section', id: `category-${category.id}`, 'aria-labelledby': `category-${category.id}-title` },
        h('h2', { id: `category-${category.id}-title` }, category.name),
        h('div', { class: 'item-grid' }, category.items.map(itemCard)),
      ),
    ),
  );
  $('#sections').removeAttribute('aria-busy');
  for (const id of state.controls.keys()) updateControl(id);
  $('#menu-empty').hidden = categories.length > 0;
  $('#category-nav').hidden = categories.length < 2;
  $('#category-links').replaceChildren(
    ...categories.map((category) =>
      h('li', {}, h('a', { href: `#category-${category.id}`, dataset: { category: String(category.id) } }, category.name)),
    ),
  );
  watchSections();
}

/** Highlights the category being read in the sticky nav (and keeps its link in view). */
let observer;
function watchSections() {
  observer?.disconnect();
  if (!('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id.replace('category-', '');
        for (const link of document.querySelectorAll('#category-links a')) {
          const current = link.dataset.category === id;
          if (current) {
            link.setAttribute('aria-current', 'true');
            const list = $('#category-links');
            list.scrollTo({ left: link.offsetLeft - list.clientWidth / 2 + link.clientWidth / 2, behavior: 'smooth' });
          } else link.removeAttribute('aria-current');
        }
      }
    },
    { rootMargin: '-35% 0px -60% 0px' },
  );
  for (const section of document.querySelectorAll('.menu-section')) observer.observe(section);
}

async function loadMenu() {
  const data = await api('/api/menu');
  state.store = data.store;
  state.categories = data.categories;
  state.items = new Map(data.categories.flatMap((category) => category.items.map((item) => [item.id, item])));
  const removed = pruneCart();
  renderStore();
  renderMenu();
  renderCart();
  return removed;
}

// ---------------------------------------------------------------------------------------------------------
// Cart and checkout

function fulfillment() {
  return state.store?.delivery_enabled && form.elements.fulfillment.value === 'delivery' ? 'delivery' : 'pickup';
}

function renderCart() {
  const count = cartCount();
  const sub = subtotal();
  $('#cart-bar').hidden = count === 0;
  $('#cart-bar-count').textContent = count === 1 ? t('cart.countOne') : t('cart.countMany', { count });
  $('#cart-bar-total').textContent = money(sub);

  // Re-rendering the lines would lose the focus: remember which control had it
  const focused = document.activeElement?.dataset?.focus;
  $('#cart-lines').replaceChildren(
    ...[...state.cart].map(([id, qty]) => {
      const item = state.items.get(id);
      if (!item) return null;
      return h(
        'li',
        { class: 'cart-line' },
        h(
          'div',
          { class: 'cart-line-info' },
          h('strong', {}, item.name),
          h('span', { class: 'muted small' }, `${qty} × ${money(item.price_cents)}`),
        ),
        h(
          'div',
          { class: 'stepper' },
          h('button', {
            class: 'step-btn',
            type: 'button',
            'aria-label': t('item.decrease', { name: item.name }),
            dataset: { focus: `minus-${id}` },
            onclick: () => setQty(id, qty - 1),
            text: '−',
          }),
          h('span', { class: 'step-count' }, String(qty)),
          h('button', {
            class: 'step-btn',
            type: 'button',
            'aria-label': t('item.increase', { name: item.name }),
            dataset: { focus: `plus-${id}` },
            disabled: qty >= MAX_QTY,
            onclick: () => setQty(id, qty + 1),
            text: '+',
          }),
        ),
        h('span', { class: 'cart-line-total' }, money(item.price_cents * qty)),
        h('button', {
          class: 'btn ghost small remove-btn',
          type: 'button',
          'aria-label': t('cart.remove', { name: item.name }),
          title: t('cart.remove', { name: item.name }),
          dataset: { focus: `remove-${id}` },
          onclick: () => setQty(id, 0),
          text: '✕',
        }),
      );
    }),
  );
  if (focused && dialog.open) {
    const again = dialog.querySelector(`[data-focus="${focused}"]`);
    (again && !again.disabled ? again : $('#close-cart')).focus();
  }

  $('#cart-empty').hidden = count > 0;
  form.hidden = count === 0;
  const delivery = fulfillment() === 'delivery';
  const fee = delivery ? (state.store?.delivery_fee_cents ?? 0) : 0;
  $('#field-address').hidden = !delivery;
  form.elements.address.required = delivery;
  $('#total-subtotal').textContent = money(sub);
  $('#total-fee-row').hidden = !delivery;
  $('#total-fee').textContent = fee > 0 ? money(fee) : t('cart.free');
  $('#total-total').textContent = money(sub + fee);

  // Why the order can't be placed yet (the server checks all of this again)
  let notice = '';
  if (state.store && !state.store.open) notice = t('cart.closed');
  else if (state.store && !state.store.has_whatsapp) notice = t('cart.noWhatsapp');
  else if (state.store && sub < state.store.min_order_cents) {
    notice = t('cart.belowMinimum', { missing: money(state.store.min_order_cents - sub), min: money(state.store.min_order_cents) });
  }
  $('#checkout-notice').textContent = notice;
  $('#checkout-notice').hidden = notice === '';
  $('#checkout-submit').disabled = notice !== '';
}

function showCartMessage(text) {
  $('#cart-message').textContent = text;
  $('#cart-message').hidden = text === '';
}

function openCart() {
  $('#checkout-error').hidden = true;
  $('#cart-view').hidden = false;
  $('#done').hidden = true;
  dialog.showModal();
}

/** The order as a WhatsApp message, in the customer's language. */
function whatsappMessage(order, values) {
  const lines = [
    t('wa.header', { code: order.code, store: storeName() }),
    '',
    ...order.items.map((line) => `${line.qty}x ${line.name} — ${money(line.line_cents)}`),
    '',
    `${t('cart.subtotal')}: ${money(order.subtotal_cents)}`,
    values.fulfillment === 'delivery' ? `${t('cart.fee')}: ${order.fee_cents > 0 ? money(order.fee_cents) : t('cart.free')}` : null,
    `*${t('cart.total')}: ${money(order.total_cents)}*`,
    '',
    `${t('wa.name')}: ${values.name.trim()}`,
    values.phone.trim() ? `${t('wa.phone')}: ${values.phone.trim()}` : null,
    values.fulfillment === 'delivery' ? `${t('wa.delivery')}: ${values.address.trim()}` : t('wa.pickup'),
    values.note.trim() ? `${t('wa.note')}: ${values.note.trim()}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

function showDone(order, values) {
  const href = `https://wa.me/${order.whatsapp}?text=${encodeURIComponent(whatsappMessage(order, values))}`;
  $('#whatsapp-link').href = href;
  $('#done-title').textContent = t('done.title', { code: order.code });
  state.cart.clear();
  saveCart();
  for (const id of state.controls.keys()) updateControl(id);
  renderCart();
  form.elements.note.value = '';
  $('#cart-view').hidden = true;
  $('#done').hidden = false;
  $('#done').focus();
  // Opening WhatsApp right away may be blocked as a popup: the big link above is always there
  window.open(href, '_blank', 'noopener');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#checkout-error');
  error.hidden = true;
  if (!form.checkValidity()) {
    const invalid = form.querySelector(':invalid');
    error.textContent = t(`error.invalid_${invalid?.name ?? 'name'}`);
    error.hidden = false;
    invalid?.focus();
    return;
  }
  const values = { ...formValues(form), fulfillment: fulfillment() };
  const button = $('#checkout-submit');
  button.disabled = true;
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: { ...values, items: [...state.cart].map(([id, qty]) => ({ id, qty })) },
    });
    showDone(order, values);
  } catch (failure) {
    if (failure.code === 'item_unavailable') {
      for (const id of failure.data?.items ?? []) state.cart.delete(id);
      saveCart();
    }
    // The menu or the store changed meanwhile: show the current one
    if (['item_unavailable', 'below_minimum', 'store_closed', 'whatsapp_missing', 'delivery_unavailable'].includes(failure.code)) {
      await loadMenu().catch(() => {});
    }
    error.textContent = errorText(failure);
    error.hidden = false;
  } finally {
    renderCart();
    button.disabled = !$('#checkout-notice').hidden;
  }
});

form.addEventListener('change', (event) => {
  if (event.target.name === 'fulfillment') renderCart();
});

$('#open-cart').addEventListener('click', openCart);
$('#close-cart').addEventListener('click', () => dialog.close());
$('#new-order').addEventListener('click', () => dialog.close());
// A click on the dim backdrop (outside the panel) closes the cart
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener('close', () => {
  showCartMessage('');
  $('#open-cart').focus();
});

async function start() {
  ready();
  loadCart();
  try {
    const removed = await loadMenu();
    if (removed > 0) showCartMessage(t('cart.removedItems'));
    $('#menu-error').hidden = true;
  } catch (failure) {
    $('#menu-error-text').textContent = errorText(failure);
    $('#menu-error').hidden = false;
    if (!state.store) $('#store-name').textContent = t('store.defaultName');
  }
}

$('#menu-retry').addEventListener('click', start);

start();

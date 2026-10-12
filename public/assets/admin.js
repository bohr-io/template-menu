// The admin: orders (with stats and auto refresh), the menu editor and the store settings.
import { $, adminGate, api, busy, errorText, formatDateTime, formatMoney, formatNumber, formValues, h, lang, t, toast } from './ui.js';

const REFRESH_MS = 30_000;

const state = {
  status: '',
  page: 1,
  pages: 1,
  currency: 'BRL',
  menu: { categories: [], items: [] },
  /** The newest order id seen, to tell the owner when new orders arrive. */
  latestId: null,
  editingItem: null,
  editingCategory: null,
};

const money = (cents) => formatMoney(cents, state.currency);

// ---------------------------------------------------------------------------------------------------------
// Money inputs: the owner types "12,90" or "12.90" (or "1.234,50"); the API takes integer cents

function toCents(value) {
  const typed = String(value ?? '')
    .trim()
    .replace(/\s/g, '');
  if (typed === '') return null;
  // The last "," or "." followed by at most 2 digits is the decimal separator; the others group thousands
  const last = Math.max(typed.lastIndexOf(','), typed.lastIndexOf('.'));
  let normalized = typed.replace(/[.,]/g, '');
  if (last !== -1 && typed.length - last - 1 <= 2) {
    const decimals = typed.slice(last + 1);
    normalized = typed.slice(0, last).replace(/[.,]/g, '') + (decimals ? `.${decimals}` : '');
  }
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

function fromCents(cents) {
  return new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(cents / 100);
}

/** Shows an API error inside a form (or sends the admin back to the login when the session ended). */
function formError(element, failure) {
  if (failure?.code === 'unauthorized') location.reload();
  element.textContent = errorText(failure);
  element.hidden = false;
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}

const currentTab = () => $('[role="tab"][aria-selected="true"]').id.slice(4);

// ---------------------------------------------------------------------------------------------------------
// Orders

async function loadStats() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const stats = await api(`/api/admin/stats?since=${encodeURIComponent(midnight.toISOString())}`);
  state.currency = stats.currency;
  $('#stat-today').textContent = formatNumber(stats.today);
  $('#stat-revenue').textContent = money(stats.revenue_today);
  $('#stat-pending').textContent = formatNumber(stats.pending);
  if (state.latestId !== null && stats.latest_id > state.latestId) {
    const count = stats.latest_id - state.latestId;
    toast(count === 1 ? t('orders.newOne') : t('orders.newMany', { count }));
  }
  state.latestId = stats.latest_id;
}

function orderCard(order) {
  const badge = { new: 'accent', done: 'success', cancelled: 'danger' }[order.status] ?? '';
  const action = (label, status, kind = '') =>
    h('button', {
      class: `btn small ${kind}`,
      type: 'button',
      text: label,
      onclick: (event) => setStatus(order, status, event.currentTarget),
    });
  return h(
    'article',
    { class: `card order-card status-${order.status}`, 'aria-label': `#${order.code}` },
    h(
      'div',
      { class: 'order-head' },
      h('span', { class: 'order-code' }, `#${order.code}`),
      h('span', { class: `badge ${badge}` }, t(`status.${order.status}`)),
    ),
    h('div', { class: 'muted small' }, formatDateTime(order.created_at)),
    h(
      'div',
      { class: 'order-meta' },
      h('strong', {}, order.customer_name),
      order.phone ? h('a', { href: `tel:${order.phone.replace(/[^\d+]/g, '')}` }, order.phone) : null,
      h('span', {}, order.fulfillment === 'delivery' ? t('orders.delivery') : t('orders.pickup')),
      order.address ? h('span', { class: 'multiline' }, order.address) : null,
      order.note ? h('span', { class: 'multiline muted' }, `“${order.note}”`) : null,
    ),
    h(
      'ul',
      { class: 'order-lines' },
      order.items.map((line) => h('li', {}, h('span', {}, `${line.qty}× ${line.name}`), h('span', {}, money(line.line_cents)))),
    ),
    order.fulfillment === 'delivery'
      ? [
          h('div', { class: 'order-sum muted small' }, h('span', {}, t('cart.subtotal')), h('span', {}, money(order.subtotal_cents))),
          h('div', { class: 'order-sum muted small' }, h('span', {}, t('cart.fee')), h('span', {}, money(order.fee_cents))),
        ]
      : null,
    h('div', { class: 'order-sum grand' }, h('span', {}, t('cart.total')), h('span', {}, money(order.total_cents))),
    h(
      'div',
      { class: 'order-actions' },
      order.status === 'new'
        ? [action(t('orders.markDone'), 'done', 'primary'), action(t('orders.cancel'), 'cancelled', 'danger')]
        : action(t('orders.reopen'), 'new'),
    ),
  );
}

async function loadOrders() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.status) params.set('status', state.status);
  const data = await api(`/api/admin/orders?${params}`);
  state.pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $('#orders').replaceChildren(...data.items.map(orderCard));
  $('#orders-empty').textContent = state.status ? t('orders.emptyFilter') : t('orders.empty');
  $('#orders-empty').hidden = data.total > 0;
  $('#page-info').textContent = t('pager.info', { page: state.page, pages: state.pages });
  $('#prev').disabled = state.page <= 1;
  $('#next').disabled = state.page >= state.pages;
}

async function setStatus(order, status, button) {
  if (status === 'cancelled' && !confirm(t('orders.cancelConfirm', { code: order.code }))) return;
  await busy(button, async () => {
    await api(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { status } });
    toast(t('orders.updated'));
    await Promise.all([loadOrders(), loadStats()]);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Menu editor

/** Same colored tile with the initial as the public page, for items without a photo. */
function thumbnail(item) {
  const tile = () => {
    const element = h('div', { class: 'item-photo placeholder', 'aria-hidden': 'true' }, ([...item.name.trim()][0] ?? '•').toUpperCase());
    element.style.setProperty('--hue', String([18, 32, 45, 140, 195, 340][item.id % 6]));
    return element;
  };
  if (!item.photo_url) return tile();
  return h('img', {
    class: 'item-photo',
    src: item.photo_url,
    alt: '',
    loading: 'lazy',
    onerror: (event) => event.currentTarget.replaceWith(tile()),
  });
}

function moveButtons(kind, row, index, count) {
  const move = (direction, button) =>
    busy(button, async () => {
      await api(`/api/admin/${kind}/${row.id}/move`, { method: 'POST', body: { direction } });
      await loadMenu();
      // Keep the keyboard on the moved row's arrow (the other one when this one is now disabled)
      const same = $(`[data-move="${kind}-${row.id}-${direction}"]`);
      const other = $(`[data-move="${kind}-${row.id}-${direction === 'up' ? 'down' : 'up'}"]`);
      (same && !same.disabled ? same : other)?.focus();
    });
  return [
    h('button', {
      class: 'btn small ghost',
      type: 'button',
      text: '↑',
      title: t('menuAdmin.moveUp', { name: row.name }),
      'aria-label': t('menuAdmin.moveUp', { name: row.name }),
      disabled: index === 0,
      dataset: { move: `${kind}-${row.id}-up` },
      onclick: (event) => move('up', event.currentTarget),
    }),
    h('button', {
      class: 'btn small ghost',
      type: 'button',
      text: '↓',
      title: t('menuAdmin.moveDown', { name: row.name }),
      'aria-label': t('menuAdmin.moveDown', { name: row.name }),
      disabled: index === count - 1,
      dataset: { move: `${kind}-${row.id}-down` },
      onclick: (event) => move('down', event.currentTarget),
    }),
  ];
}

function itemPayload(item, changes = {}) {
  const { category_id, name, description, price_cents, photo_url, available } = { ...item, ...changes };
  return { category_id, name, description, price_cents, photo_url, available };
}

function itemRow(item, index, count) {
  return h(
    'li',
    { class: `admin-item${item.available ? '' : ' unavailable'}` },
    thumbnail(item),
    h(
      'div',
      { class: 'admin-item-info' },
      h('strong', {}, item.name),
      h('span', { class: 'muted small' }, money(item.price_cents)),
      item.available ? null : h('span', { class: 'badge warning' }, t('menuAdmin.unavailable')),
    ),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'label',
        { class: 'check small' },
        h('input', {
          type: 'checkbox',
          checked: item.available,
          'aria-label': t('menuAdmin.availableLabel', { name: item.name }),
          onchange: (event) => {
            const box = event.currentTarget;
            busy(box, async () => {
              await api(`/api/admin/items/${item.id}`, { method: 'PUT', body: itemPayload(item, { available: box.checked }) });
              await loadMenu();
              $(`[data-available="${item.id}"]`)?.focus();
            });
          },
          dataset: { available: String(item.id) },
        }),
        h('span', { 'aria-hidden': 'true' }, t('menuAdmin.available')),
      ),
      moveButtons('items', item, index, count),
      h('button', {
        class: 'btn small',
        type: 'button',
        text: t('menuAdmin.edit'),
        'aria-label': t('menuAdmin.editLabel', { name: item.name }),
        onclick: () => openItem(item),
      }),
      h('button', {
        class: 'btn small danger',
        type: 'button',
        text: t('common.delete'),
        'aria-label': t('menuAdmin.deleteLabel', { name: item.name }),
        onclick: (event) => deleteRow('items', item, t('menuAdmin.itemDeleteConfirm', { name: item.name }), event.currentTarget),
      }),
    ),
  );
}

function categoryBlock(category, index, count) {
  const items = state.menu.items.filter((item) => item.category_id === category.id);
  const titleId = `category-${category.id}-title`;
  return h(
    'section',
    { class: 'card category-block', 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'category-head' },
      h('h3', { id: titleId }, category.name),
      category.visible ? null : h('span', { class: 'badge' }, t('menuAdmin.hidden')),
      h(
        'div',
        { class: 'row-actions' },
        moveButtons('categories', category, index, count),
        h('button', {
          class: 'btn small',
          type: 'button',
          text: t('menuAdmin.edit'),
          'aria-label': t('menuAdmin.editLabel', { name: category.name }),
          onclick: () => openCategory(category),
        }),
        h('button', {
          class: 'btn small danger',
          type: 'button',
          text: t('common.delete'),
          'aria-label': t('menuAdmin.deleteLabel', { name: category.name }),
          onclick: (event) =>
            deleteRow('categories', category, t('menuAdmin.categoryDeleteConfirm', { name: category.name }), event.currentTarget),
        }),
        h('button', {
          class: 'btn small primary',
          type: 'button',
          text: `+ ${t('menuAdmin.addItem')}`,
          onclick: () => openItem(null, category.id),
        }),
      ),
    ),
    items.length > 0
      ? h(
          'ul',
          { class: 'admin-items' },
          items.map((item, itemIndex) => itemRow(item, itemIndex, items.length)),
        )
      : h('p', { class: 'muted small empty' }, t('menuAdmin.noItems')),
  );
}

async function loadMenu() {
  state.menu = await api('/api/admin/menu');
  const { categories } = state.menu;
  $('#menu-admin').replaceChildren(...categories.map((category, index) => categoryBlock(category, index, categories.length)));
  $('#menu-admin-empty').hidden = categories.length > 0;
}

async function deleteRow(kind, row, question, button) {
  if (!confirm(question)) return;
  await busy(button, async () => {
    await api(`/api/admin/${kind}/${row.id}`, { method: 'DELETE' });
    toast(t('menuAdmin.deleted'));
    await loadMenu();
  });
}

function openCategory(category) {
  state.editingCategory = category;
  const form = $('#category-form');
  form.reset();
  $('#category-error').hidden = true;
  $('#category-dialog-title').textContent = t(category ? 'categoryForm.edit' : 'categoryForm.new');
  form.elements.name.value = category?.name ?? '';
  form.elements.visible.checked = category?.visible ?? true;
  $('#category-dialog').showModal();
}

function updatePreview() {
  const value = $('#item-form').elements.photo_url.value.trim();
  const preview = $('#photo-preview');
  preview.hidden = !/^https:\/\/\S+$/.test(value);
  if (!preview.hidden && preview.getAttribute('src') !== value) preview.src = value;
}

function openItem(item, categoryId) {
  state.editingItem = item;
  const form = $('#item-form');
  form.reset();
  $('#item-error').hidden = true;
  $('#item-dialog-title').textContent = t(item ? 'itemForm.edit' : 'itemForm.new');
  $('#price-currency').textContent = state.currency;
  form.elements.category_id.replaceChildren(
    ...state.menu.categories.map((category) => h('option', { value: String(category.id) }, category.name)),
  );
  form.elements.category_id.value = String(item?.category_id ?? categoryId);
  form.elements.name.value = item?.name ?? '';
  form.elements.description.value = item?.description ?? '';
  form.elements.price.value = item ? fromCents(item.price_cents) : '';
  form.elements.photo_url.value = item?.photo_url ?? '';
  form.elements.available.checked = item?.available ?? true;
  updatePreview();
  $('#item-dialog').showModal();
}

// ---------------------------------------------------------------------------------------------------------
// Settings

function showSettings(settings) {
  state.currency = settings.currency;
  const form = $('#settings');
  form.elements.currency.replaceChildren(...settings.currencies.map((code) => h('option', { value: code }, code)));
  form.elements.store_name.value = settings.store_name;
  form.elements.store_description.value = settings.store_description;
  form.elements.whatsapp.value = settings.whatsapp;
  form.elements.currency.value = settings.currency;
  form.elements.open.checked = settings.open;
  form.elements.delivery_enabled.checked = settings.delivery_enabled;
  form.elements.delivery_fee.value = fromCents(settings.delivery_fee_cents);
  form.elements.min_order.value = fromCents(settings.min_order_cents);
  // Without a WhatsApp number nobody can order: say so everywhere
  $('#whatsapp-banner').hidden = settings.whatsapp !== '';
  $('#field-whatsapp').classList.toggle('field-warning', settings.whatsapp === '');
}

async function loadSettings() {
  showSettings(await api('/api/admin/settings'));
}

// ---------------------------------------------------------------------------------------------------------

async function refresh() {
  if (document.visibilityState !== 'visible') return;
  await busy(null, () => Promise.all([loadStats(), currentTab() === 'orders' ? loadOrders() : null]));
}

async function start() {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  }
  $('#whatsapp-go').addEventListener('click', () => {
    selectTab('settings');
    $('#settings').elements.whatsapp.focus();
  });

  for (const button of document.querySelectorAll('#status-filter button')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('#status-filter button')) other.setAttribute('aria-pressed', String(other === button));
      state.status = button.dataset.status;
      state.page = 1;
      busy(null, loadOrders);
    });
  }
  $('#prev').addEventListener('click', () => {
    state.page -= 1;
    busy(null, loadOrders);
  });
  $('#next').addEventListener('click', () => {
    state.page += 1;
    busy(null, loadOrders);
  });

  $('#add-category').addEventListener('click', () => openCategory(null));
  for (const button of document.querySelectorAll('dialog [data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  $('#category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const category = state.editingCategory;
    try {
      event.submitter.disabled = true;
      const body = { name: form.elements.name.value, visible: form.elements.visible.checked };
      await api(category ? `/api/admin/categories/${category.id}` : '/api/admin/categories', { method: category ? 'PUT' : 'POST', body });
      $('#category-dialog').close();
      toast(t('common.saved'));
      await busy(null, loadMenu);
    } catch (failure) {
      formError($('#category-error'), failure);
    } finally {
      event.submitter.disabled = false;
    }
  });

  $('#item-form').elements.photo_url.addEventListener('input', updatePreview);
  $('#photo-preview').addEventListener('error', () => {
    $('#photo-preview').hidden = true;
  });
  $('#item-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const item = state.editingItem;
    const values = formValues(form);
    const price = toCents(values.price);
    if (price === null) return formError($('#item-error'), { code: 'invalid_price_cents' });
    try {
      event.submitter.disabled = true;
      const body = {
        category_id: Number(values.category_id),
        name: values.name,
        description: values.description,
        price_cents: price,
        photo_url: values.photo_url,
        available: values.available,
      };
      await api(item ? `/api/admin/items/${item.id}` : '/api/admin/items', { method: item ? 'PUT' : 'POST', body });
      $('#item-dialog').close();
      toast(t('common.saved'));
      await busy(null, loadMenu);
    } catch (failure) {
      formError($('#item-error'), failure);
    } finally {
      event.submitter.disabled = false;
    }
  });

  $('#settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#settings-error');
    error.hidden = true;
    const values = formValues(event.target);
    const fee = toCents(values.delivery_fee || '0');
    const minimum = toCents(values.min_order || '0');
    if (fee === null) return formError(error, { code: 'invalid_delivery_fee_cents' });
    if (minimum === null) return formError(error, { code: 'invalid_min_order_cents' });
    try {
      event.submitter.disabled = true;
      const { delivery_fee, min_order, ...rest } = values;
      showSettings(
        await api('/api/admin/settings', { method: 'PUT', body: { ...rest, delivery_fee_cents: fee, min_order_cents: minimum } }),
      );
      toast(t('common.saved'));
      // Amounts elsewhere follow the (maybe new) currency
      await busy(null, () => Promise.all([loadStats(), loadOrders(), loadMenu()]));
    } catch (failure) {
      formError(error, failure);
    } finally {
      event.submitter.disabled = false;
    }
  });

  await busy(null, () => Promise.all([loadSettings(), loadStats()]));
  await busy(null, () => Promise.all([loadOrders(), loadMenu()]));
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', refresh);
}

adminGate(start);

'use strict';
const $ = id => document.getElementById(id);
const DAY = 86400000;
let data = null, filter = 'all', tab = 'users', selectedId = null, refreshTimer = null, lastSync = 0, busy = false;

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function icon(name) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; }
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const date = t => t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const dateTime = t => t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
function relative(t) {
  if (!t) return '';
  const diff = t - Date.now(), abs = Math.abs(diff), future = diff > 0;
  const days = Math.round(abs / DAY), unit = abs < 3600000 ? [Math.max(1, Math.round(abs / 60000)), 'min'] : abs < DAY ? [Math.round(abs / 3600000), 'h'] : [days, days === 1 ? 'day' : 'days'];
  return future ? 'in ' + unit.join(' ') : unit.join(' ') + ' ago';
}
const statusLabel = { active: 'Active', expired: 'Expired', pending: 'Pending', suspended: 'Suspended', admin: 'Admin' };
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
function avatar(u) {
  const a = el('span', 'avatar c' + (parseInt(u.id.slice(-2), 16) % 5), initials(u.name));
  if (u.avatar) { const img = el('img'); img.src = u.avatar; img.alt = ''; img.onerror = () => img.remove(); a.append(img); }
  return a;
}
function toast(text, bad) { const t = $('toast'); t.textContent = text; t.classList.toggle('bad', !!bad); t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.hidden = true, 4200); }

async function api(route, body) {
  let r;
  try { r = await fetch('/api/' + route, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); }
  catch { throw Error('Unable to reach the server.'); }
  let json = {}; try { json = await r.json(); } catch {}
  if (!r.ok) { const e = Error(json.error || 'The request could not be completed.'); e.status = r.status; throw e; }
  return json;
}

// ----- Gate -----
function showGate(title, text) {
  clearInterval(refreshTimer); $('shell').hidden = true; $('gate').hidden = false;
  $('gateTitle').textContent = title; $('gateText').textContent = text; $('gateUser').focus();
}
$('gateForm').onsubmit = async e => {
  e.preventDefault(); $('gateError').hidden = true; $('gateSubmit').disabled = true;
  try {
    const me = await api('login', { username: $('gateUser').value.trim(), password: $('gatePass').value });
    $('gatePass').value = '';
    if (me.me?.role !== 'admin') { await api('logout', {}).catch(() => {}); throw Error('This account is not an administrator.'); }
    await load(); start();
  } catch (err) { $('gateError').textContent = err.message; $('gateError').hidden = false; }
  finally { $('gateSubmit').disabled = false; }
};

// ----- Loading -----
async function load(quiet) {
  if (busy && quiet) return;
  $('refresh').classList.add('spinning');
  try { apply(await api('admin/overview')); }
  catch (e) {
    if (e.status === 401) return showGate('Administrator sign in', 'Sign in with an administrator account to manage users, subscriptions and payments.');
    if (e.status === 403) return showGate('Administrator access required', 'You are signed in with an account that is not an administrator. Sign in with an administrator account.');
    if (!quiet) toast(e.message, true); else $('sync').textContent = 'Offline · retrying';
  } finally { $('refresh').classList.remove('spinning'); }
}
function start() {
  $('gate').hidden = true; $('shell').hidden = false;
  clearInterval(refreshTimer); refreshTimer = setInterval(() => { if (!document.hidden) load(true); }, 15000);
}
setInterval(() => { if (lastSync) $('sync').textContent = 'Updated ' + (Date.now() - lastSync < 5000 ? 'just now' : relative(lastSync)); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data) load(true); });

function apply(next) {
  data = next; lastSync = Date.now(); $('sync').textContent = 'Updated just now';
  $('priceLine').textContent = 'Plan: ' + money(data.price) + ' per month · subscriptions expire automatically';
  renderStats(); renderFilters(); renderUsers(); renderPayments();
  if (selectedId) { const u = data.users.find(x => x.id === selectedId); if (u && $('manage').open) renderManage(u); else if (!u && $('manage').open) $('manage').close(); }
}
const isSoon = u => u.status === 'active' && u.paidUntil && u.paidUntil - Date.now() < 7 * DAY;

// ----- Stats -----
function renderStats() {
  const s = data.stats, box = $('stats'); box.replaceChildren();
  const cards = [
    ['all', 'Total users', s.total, s.online + ' online now', 'online'],
    ['active', 'Active', s.active, 'Paying subscribers', 'active'],
    ['soon', 'Expiring ≤ 7 days', s.expiringSoon, 'Need renewal soon', 'soon'],
    ['expired', 'Expired', s.expired, 'Access locked', 'expired'],
    ['pending', 'Pending', s.pending, 'Never paid', 'pending'],
    ['suspended', 'Suspended', s.suspended, 'Blocked by admin', 'suspended'],
    [null, 'Monthly recurring', money(s.mrr), s.active + ' × ' + money(data.price), null, true],
    [null, 'Revenue this month', money(s.revenueMonth), 'Recorded payments', null, true],
    [null, 'Total revenue', money(s.revenue), data.payments.length + ' payments', null, true]
  ];
  for (const [key, label, value, note, dot, isMoney] of cards) {
    const c = el(key ? 'button' : 'div', 'stat' + (isMoney ? ' money' : '') + (key && key === filter && tab === 'users' ? ' selected' : ''));
    const head = el('span'); if (dot) head.append(el('i', 'dot ' + dot)); head.append(label);
    c.append(head, el('strong', '', String(value)), el('small', '', note));
    if (key) { c.type = 'button'; c.onclick = () => { setTab('users'); filter = key; renderStats(); renderFilters(); renderUsers(); }; }
    else if (isMoney) { c.onclick = () => setTab('payments'); c.classList.add('clickable'); }
    box.append(c);
  }
}

// ----- Users -----
function renderFilters() {
  const counts = { all: data.users.length, soon: data.users.filter(isSoon).length };
  for (const u of data.users) counts[u.status] = (counts[u.status] || 0) + 1;
  const box = $('filters'); box.replaceChildren();
  for (const [key, label] of [['all', 'All'], ['active', 'Active'], ['soon', 'Expiring'], ['expired', 'Expired'], ['pending', 'Pending'], ['suspended', 'Suspended'], ['admin', 'Admins']]) {
    const b = el('button', 'chip' + (filter === key ? ' active' : '')); b.type = 'button';
    if (!['all', 'soon'].includes(key)) b.append(el('i', 'dot ' + key)); else if (key === 'soon') b.append(el('i', 'dot soon'));
    b.append(label, el('b', '', String(counts[key] || 0)));
    b.onclick = () => { filter = key; renderFilters(); renderStats(); renderUsers(); };
    box.append(b);
  }
  $('usersTabCount').textContent = data.users.length;
}
function visibleUsers() {
  const q = $('userSearch').value.trim().replace(/^@/, '').toLowerCase();
  let list = data.users.filter(u => filter === 'all' || (filter === 'soon' ? isSoon(u) : u.status === filter));
  if (q) list = list.filter(u => (u.name + ' ' + u.username + ' ' + u.note).toLowerCase().includes(q));
  const sort = $('sortBy').value, far = 8.64e15;
  const keys = { expiry: u => u.status === 'admin' ? far : u.paidUntil || far - 1, joined: u => -(u.createdAt || 0), login: u => -(u.lastLoginAt || 0), paid: u => -u.totalPaid, name: u => u.name.toLowerCase() };
  const k = keys[sort];
  return list.sort((a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name); });
}
function cell(label, ...content) { const td = el('td'); td.dataset.label = label; td.append(...content); return td; }
function renderUsers() {
  const rows = $('userRows'); rows.replaceChildren();
  const list = visibleUsers();
  for (const u of list) {
    const tr = el('tr');
    const who = el('div', 'user-cell'), names = el('div', 'names'), handle = el('small');
    handle.append('@' + u.username); if (u.online) { handle.append(el('i', 'dot online'), 'online'); }
    names.append(el('strong', '', u.name), handle);
    if (u.note) names.append(el('span', 'note', u.note));
    who.append(avatar(u), names);
    const badge = el('span', 'badge ' + u.status); badge.append(el('i', 'dot ' + u.status), statusLabel[u.status]);
    if (u.deletionAt) badge.title = 'Emergency deletion scheduled ' + dateTime(u.deletionAt);
    const expires = el('div');
    if (u.status === 'admin') expires.append(el('span', 'when muted', 'No expiry'));
    else if (u.paidUntil) { expires.append(el('span', 'when', date(u.paidUntil)), el('span', 'sub' + (u.paidUntil < Date.now() ? ' late' : isSoon(u) ? ' soon' : ''), relative(u.paidUntil))); }
    else expires.append(el('span', 'when muted', 'Not paid'));
    const paid = el('div'); paid.append(el('span', 'when', money(u.totalPaid)), el('span', 'sub', u.payments + (u.payments === 1 ? ' payment' : ' payments')));
    const login = el('div'); login.append(el('span', 'when', u.lastLoginAt ? relative(u.lastLoginAt) : 'Never'));
    const actions = el('div', 'actions');
    if (u.status !== 'admin') {
      const renew = el('button', 'btn small renew', (u.status === 'active' ? 'Renew' : 'Activate') + ' · ' + money(data.price)); renew.type = 'button';
      renew.title = 'Record ' + money(data.price) + ' and add one month';
      renew.onclick = () => quickRenew(u, renew);
      actions.append(renew);
    }
    const manage = el('button', 'btn small', 'Manage'); manage.type = 'button'; manage.onclick = () => openManage(u.id);
    actions.append(manage);
    const actionCell = el('td', 'right'); actionCell.append(actions);
    tr.append(cell('User', who), cell('Status', badge), cell('Expires', expires), cell('Paid', paid), cell('Last sign-in', login), cell('Joined', el('span', 'muted', date(u.createdAt))), actionCell);
    rows.append(tr);
  }
  $('usersEmpty').hidden = list.length > 0;
}
async function quickRenew(u, button) {
  button.disabled = true;
  try { apply(await api('admin/extend', { id: u.id, months: 1 })); toast(u.name + ' is active until ' + date(data.users.find(x => x.id === u.id)?.paidUntil) + '. ' + money(data.price) + ' recorded.'); }
  catch (e) { toast(e.message, true); button.disabled = false; }
}
$('userSearch').oninput = renderUsers; $('sortBy').onchange = renderUsers;

// ----- Payments -----
function renderPayments() {
  const q = $('paymentSearch').value.trim().replace(/^@/, '').toLowerCase();
  const list = data.payments.filter(p => !q || (p.name + ' ' + p.username + ' ' + p.note + ' ' + p.by).toLowerCase().includes(q));
  const rows = $('paymentRows'); rows.replaceChildren();
  for (const p of list) {
    const tr = el('tr');
    const who = el('div', 'user-cell'), names = el('div', 'names'); names.append(el('strong', '', p.name), el('small', '', '@' + p.username)); who.append(names);
    const del = el('button', 'btn small', 'Remove'); del.type = 'button';
    del.onclick = async () => {
      if (!confirm('Remove the ' + money(p.amount) + ' payment from ' + p.name + '? The expiry date does not change.')) return;
      del.disabled = true; try { apply(await api('admin/delete-payment', { id: p.id })); toast('Payment removed.'); } catch (e) { toast(e.message, true); del.disabled = false; }
    };
    const actionCell = el('td', 'right'); actionCell.append(del);
    tr.append(cell('Date', el('span', '', dateTime(p.at))), cell('User', who), cell('Period', el('span', '', p.months + (p.months === 1 ? ' month' : ' months'))), cell('Amount', el('strong', '', money(p.amount))), cell('Recorded by', el('span', 'muted', '@' + p.by)), cell('Note', el('span', 'muted', p.note || '—')), actionCell);
    rows.append(tr);
  }
  $('paymentsEmpty').hidden = list.length > 0;
  $('paymentsTabCount').textContent = data.payments.length;
  $('paymentsTotal').textContent = list.length + ' payments · ' + money(list.reduce((s, p) => s + p.amount, 0));
}
$('paymentSearch').oninput = renderPayments;

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll('.tab')) { const on = b.dataset.tab === next; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); }
  $('usersPanel').hidden = next !== 'users'; $('paymentsPanel').hidden = next !== 'payments';
  if (data) renderStats();
}
for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);

// ----- Manage drawer -----
function openManage(id) {
  selectedId = id; const u = data.users.find(x => x.id === id); if (!u) return;
  $('extMonths').value = '1'; $('extNote').value = ''; $('extRecord').checked = true; $('resetPassword').value = ''; $('deleteConfirm').value = '';
  $('extAmount').value = data.price; $('mNote').value = u.note;
  renderManage(u); $('manage').showModal();
}
function toLocalInput(t) { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
function addMonths(ts, months) { const d = new Date(ts), day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); return d.getTime(); }
function updatePreview() {
  const u = data.users.find(x => x.id === selectedId); if (!u) return;
  const months = Number($('extMonths').value), until = addMonths(Math.max(Date.now(), u.paidUntil || 0), months);
  $('extPreview').textContent = 'New expiry: ' + dateTime(until) + (u.paidUntil > Date.now() ? ' (added to the remaining time).' : '.');
}
$('extMonths').onchange = () => { $('extAmount').value = Number($('extMonths').value) * data.price; updatePreview(); };
function renderManage(u) {
  const a = $('mAvatar'); a.replaceWith(Object.assign(avatar(u), { id: 'mAvatar' }));
  $('mName').textContent = u.name; $('mUsername').textContent = '@' + u.username + (u.online ? ' · online now' : '');
  const summary = $('mSummary'); summary.replaceChildren();
  const badge = el('span', 'badge ' + u.status); badge.append(el('i', 'dot ' + u.status), statusLabel[u.status]);
  const items = [
    ['Status', badge],
    ['Expires', u.status === 'admin' ? 'No expiry' : u.paidUntil ? dateTime(u.paidUntil) + ' · ' + relative(u.paidUntil) : 'Not paid'],
    ['Total paid', money(u.totalPaid) + ' · ' + u.payments + (u.payments === 1 ? ' payment' : ' payments')],
    ['Last sign-in', u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never'],
    ['Joined', dateTime(u.createdAt)],
    ['Friends', String(u.friends)],
    ['Emergency password', u.emergencyEnabled ? 'Enabled' : 'Not set'],
    ['Emergency deletion', u.deletionAt ? dateTime(u.deletionAt) : 'None scheduled']
  ];
  for (const [label, value] of items) { const d = el('div'); const s = el('strong'); s.append(value); d.append(el('span', '', label), s); summary.append(d); }
  const isAdmin = u.status === 'admin';
  $('mSubscription').hidden = isAdmin;
  if (u.paidUntil) $('expiryInput').value = toLocalInput(u.paidUntil); else $('expiryInput').value = '';
  $('expireNow').hidden = !(u.paidUntil > Date.now()); $('clearExpiry').hidden = !u.paidUntil;
  $('extSubmit').textContent = (u.status === 'active' ? 'Extend' : 'Activate') + ' subscription';
  $('suspendUser').textContent = u.status === 'suspended' ? 'Unsuspend' : 'Suspend';
  $('suspendUser').hidden = u.envAdmin;
  $('roleUser').textContent = isAdmin ? 'Remove admin role' : 'Make admin'; $('roleUser').hidden = u.envAdmin;
  $('signOutUser').hidden = u.envAdmin;
  $('mDanger').hidden = u.envAdmin;
  const history = $('mHistory'); history.replaceChildren();
  const payments = data.payments.filter(p => p.userId === u.id);
  for (const p of payments) { const li = el('li'); li.append(el('span', '', dateTime(p.at) + ' · ' + p.months + (p.months === 1 ? ' month' : ' months') + (p.note ? ' · ' + p.note : '')), el('strong', '', money(p.amount))); history.append(li); }
  if (!payments.length) history.append(el('li', '', 'No payments recorded.'));
  updatePreview();
}
async function act(route, body, message, button) {
  if (button) button.disabled = true; busy = true;
  try { apply(await api('admin/' + route, { id: selectedId, ...body })); if (message) toast(message); return true; }
  catch (e) { toast(e.message, true); return false; }
  finally { busy = false; if (button) button.disabled = false; }
}
$('extendForm').onsubmit = async e => {
  e.preventDefault();
  const months = Number($('extMonths').value);
  if (await act('extend', { months, amount: $('extAmount').value, recordPayment: $('extRecord').checked, note: $('extNote').value }, 'Subscription extended by ' + months + (months === 1 ? ' month.' : ' months.'), $('extSubmit'))) $('extNote').value = '';
};
$('saveExpiry').onclick = () => {
  const v = $('expiryInput').value; if (!v) return toast('Choose a date and time.', true);
  act('set-expiry', { paidUntil: new Date(v).getTime() }, 'Expiry date saved.', $('saveExpiry'));
};
$('expireNow').onclick = () => { if (confirm('Expire this subscription now? The user loses access immediately.')) act('expire', {}, 'Subscription expired.', $('expireNow')); };
$('clearExpiry').onclick = () => { if (confirm('Mark this account as unpaid (pending)? The user loses access.')) act('set-expiry', { paidUntil: null }, 'Account marked as unpaid.', $('clearExpiry')); };
$('saveNote').onclick = () => act('note', { note: $('mNote').value }, 'Note saved.', $('saveNote'));
$('resetForm').onsubmit = async e => {
  e.preventDefault();
  if (await act('reset-password', { password: $('resetPassword').value }, 'Password changed. The user was signed out.')) $('resetPassword').value = '';
};
$('signOutUser').onclick = () => act('sign-out', {}, 'User signed out on all devices.', $('signOutUser'));
$('suspendUser').onclick = () => {
  const u = data.users.find(x => x.id === selectedId), suspend = u.status !== 'suspended';
  if (suspend && !confirm('Suspend ' + u.name + '? They are signed out and cannot sign in.')) return;
  act('suspend', { suspended: suspend }, suspend ? 'Account suspended.' : 'Account unsuspended.', $('suspendUser'));
};
$('roleUser').onclick = () => {
  const u = data.users.find(x => x.id === selectedId), makeAdmin = u.status !== 'admin';
  if (makeAdmin && !confirm('Give ' + u.name + ' full administrator access?')) return;
  act('role', { role: makeAdmin ? 'admin' : 'user' }, makeAdmin ? 'Administrator role granted.' : 'Administrator role removed.', $('roleUser'));
};
$('deleteForm').onsubmit = async e => {
  e.preventDefault();
  const u = data.users.find(x => x.id === selectedId);
  if ($('deleteConfirm').value.trim().toLowerCase() !== u.username) return toast('Type @' + u.username + ' without the @ to confirm.', true);
  if (await act('delete', {}, u.name + ' was deleted.')) $('manage').close();
};

// ----- Create user -----
$('newUser').onclick = () => { $('createForm').reset(); $('createError').hidden = true; $('create').showModal(); $('cName').focus(); };
$('cRole').onchange = () => { const admin = $('cRole').value === 'admin'; $('cMonths').disabled = admin; $('cRecord').disabled = admin; };
$('createForm').onsubmit = async e => {
  e.preventDefault(); $('createError').hidden = true;
  try {
    apply(await api('admin/create-user', { name: $('cName').value.trim(), username: $('cUsername').value.trim(), password: $('cPassword').value, months: Number($('cMonths').value), role: $('cRole').value, recordPayment: $('cRecord').checked }));
    $('create').close(); toast('User @' + $('cUsername').value.trim().toLowerCase() + ' created.');
  } catch (err) { $('createError').textContent = err.message; $('createError').hidden = false; }
};

// ----- CSV -----
function download(name, rows) {
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : s; }).join(',')).join('\r\n');
  const a = el('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const iso = t => t ? new Date(t).toISOString() : '';
$('exportUsers').onclick = () => download('trinum-users.csv', [['Name', 'Username', 'Status', 'Expires', 'Total paid', 'Payments', 'Last sign-in', 'Joined', 'Note'], ...visibleUsers().map(u => [u.name, u.username, u.status, iso(u.paidUntil), u.totalPaid, u.payments, iso(u.lastLoginAt), iso(u.createdAt), u.note])]);
$('exportPayments').onclick = () => download('trinum-payments.csv', [['Date', 'Name', 'Username', 'Months', 'Amount', 'Recorded by', 'Note'], ...data.payments.map(p => [iso(p.at), p.name, p.username, p.months, p.amount, p.by, p.note])]);

// ----- Shell -----
for (const b of document.querySelectorAll('.close')) b.onclick = () => b.closest('dialog').close();
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
$('manage').addEventListener('close', () => { selectedId = null; });
$('refresh').onclick = () => load();
$('signOut').onclick = async () => { await api('logout', {}).catch(() => {}); data = null; showGate('Signed out', 'Sign in again with an administrator account.'); };

load().then(() => { if (data) start(); });

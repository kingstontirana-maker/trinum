const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrinumServer } = require('./server');

const DAY = 86400000;

test('subscriptions, automatic expiry and the admin panel API', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-admin-')), dataFile = path.join(dir, 'accounts.json');
  let time = Date.UTC(2026, 0, 31, 12), server, base;
  const admin = { username: 'boss', password: 'admin-test-password' };
  async function start() { server = createTrinumServer({ dataFile, now: () => time, admin, price: 199 }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function call(route, body, cookie) {
    const r = await fetch(base + '/api/' + route, { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const register = (username, password) => call('register', { username, name: username, password, emergencyPassword: 'x', confirmEmergencyPassword: 'x', emergencyAcknowledge: true });
  try {
    await start();
    let boss = await call('login', admin), bossCookie = boss.cookie;
    let ana, anaCookie;

    await t.test('the configured administrator signs in without a subscription', async () => {
      assert.equal(boss.status, 200); assert.equal(boss.data.me.role, 'admin'); assert.equal(boss.data.me.access, true);
      assert.equal((await call('login', { username: 'boss', password: 'wrong' })).status, 401);
    });

    await t.test('any password is accepted, however weak', async () => {
      const r = await register('ana', '1'); assert.equal(r.status, 200); ana = r.data.me; anaCookie = r.cookie;
      assert.equal((await call('login', { username: 'ana', password: '1' })).status, 200);
      anaCookie = (await call('login', { username: 'ana', password: '1' })).cookie;
      assert.equal((await register('empty_pw', '')).status, 400);
    });

    await t.test('new accounts are pending and locked until paid', async () => {
      const me = await call('me', undefined, anaCookie);
      assert.equal(me.data.me.subscription.status, 'pending'); assert.equal(me.data.me.access, false); assert.equal(me.data.me.subscription.price, 199);
      assert.equal((await call('search?q=boss', undefined, anaCookie)).status, 402);
      assert.equal((await call('admin/overview', undefined, anaCookie)).status, 403);
    });

    await t.test('admin records a $199 payment and activates one month', async () => {
      const r = await call('admin/extend', { id: ana.id, months: 1 }, bossCookie); assert.equal(r.status, 200);
      const row = r.data.users.find(x => x.id === ana.id);
      assert.equal(row.status, 'active'); assert.equal(row.paidUntil, Date.UTC(2026, 1, 28, 12)); assert.equal(row.totalPaid, 199);
      assert.equal(r.data.payments[0].amount, 199); assert.equal(r.data.stats.active, 1); assert.equal(r.data.stats.mrr, 199); assert.equal(r.data.stats.revenue, 199);
      assert.equal(r.data.users.find(x => x.username === 'boss').status, 'admin');
      assert.equal(r.data.users[0].hash, undefined); assert.equal(r.data.users[0].salt, undefined);
      assert.equal((await call('search?q=boss', undefined, anaCookie)).status, 200);
    });

    await t.test('renewals stack on remaining time', async () => {
      const r = await call('admin/extend', { id: ana.id, months: 2, amount: 300, note: 'discount' }, bossCookie);
      assert.equal(r.data.users.find(x => x.id === ana.id).paidUntil, Date.UTC(2026, 3, 28, 12));
      assert.equal(r.data.stats.revenue, 499); assert.equal(r.data.payments[0].note, 'discount');
    });

    await t.test('subscriptions expire automatically', async () => {
      time = Date.UTC(2026, 3, 28, 12) + 1;
      const me = await call('me', undefined, anaCookie); assert.equal(me.data.me.subscription.status, 'expired'); assert.equal(me.data.me.access, false);
      assert.equal((await call('search?q=boss', undefined, anaCookie)).status, 402);
      const o = await call('admin/overview', undefined, bossCookie); assert.equal(o.data.stats.expired, 1); assert.equal(o.data.stats.mrr, 0);
      const renewed = await call('admin/extend', { id: ana.id, months: 1 }, bossCookie);
      assert.equal(renewed.data.users.find(x => x.id === ana.id).paidUntil, Date.UTC(2026, 4, 28, 12) + 1);
    });

    await t.test('manual expiry date, expire now and notes', async () => {
      let r = await call('admin/set-expiry', { id: ana.id, paidUntil: time + 3 * DAY }, bossCookie);
      assert.equal(r.data.users.find(x => x.id === ana.id).status, 'active'); assert.equal(r.data.stats.expiringSoon, 1);
      r = await call('admin/expire', { id: ana.id }, bossCookie); assert.equal(r.data.users.find(x => x.id === ana.id).status, 'expired');
      r = await call('admin/note', { id: ana.id, note: 'Pays in cash' }, bossCookie); assert.equal(r.data.users.find(x => x.id === ana.id).note, 'Pays in cash');
    });

    await t.test('suspension blocks sign-in and ends sessions', async () => {
      await call('admin/extend', { id: ana.id, months: 1 }, bossCookie);
      let r = await call('admin/suspend', { id: ana.id, suspended: true }, bossCookie); assert.equal(r.data.users.find(x => x.id === ana.id).status, 'suspended');
      assert.equal((await call('me', undefined, anaCookie)).status, 401);
      assert.equal((await call('login', { username: 'ana', password: '1' })).status, 403);
      r = await call('admin/suspend', { id: ana.id, suspended: false }, bossCookie); assert.equal(r.data.users.find(x => x.id === ana.id).status, 'active');
      assert.equal((await call('admin/suspend', { id: boss.data.me.id, suspended: true }, bossCookie)).status, 400);
    });

    await t.test('admin resets passwords, creates users and manages roles', async () => {
      await call('admin/reset-password', { id: ana.id, password: 'new' }, bossCookie);
      assert.equal((await call('login', { username: 'ana', password: '1' })).status, 401);
      assert.equal((await call('login', { username: 'ana', password: 'new' })).status, 200);
      let r = await call('admin/create-user', { username: 'bert', name: 'Bert', password: 'b', months: 3 }, bossCookie); assert.equal(r.status, 200);
      const bert = r.data.users.find(x => x.username === 'bert'); assert.equal(bert.status, 'active'); assert.equal(bert.totalPaid, 597);
      assert.equal((await call('admin/create-user', { username: 'bert', name: 'Bert', password: 'b' }, bossCookie)).status, 409);
      r = await call('admin/role', { id: bert.id, role: 'admin' }, bossCookie); assert.equal(r.data.users.find(x => x.id === bert.id).status, 'admin');
      assert.equal((await call('admin/role', { id: boss.data.me.id, role: 'user' }, bossCookie)).status, 400);
      const payment = r.data.payments.find(p => p.username === 'bert');
      r = await call('admin/delete-payment', { id: payment.id }, bossCookie); assert.equal(r.data.payments.some(p => p.id === payment.id), false);
      r = await call('admin/delete', { id: bert.id }, bossCookie); assert.equal(r.data.users.some(x => x.id === bert.id), false);
    });

    await t.test('subscription data and admin survive a restart', async () => {
      await stop(); await start();
      const login = await call('login', admin); assert.equal(login.data.me.role, 'admin');
      const o = await call('admin/overview', undefined, login.cookie);
      assert.equal(o.data.users.find(x => x.username === 'ana').status, 'active'); assert.ok(o.data.payments.length >= 4);
      const saved = await fs.readFile(dataFile, 'utf8'); assert.ok(!saved.includes(admin.password));
    });
  } finally { await stop().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
});

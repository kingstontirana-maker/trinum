const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrinumServer } = require('./server');

test('emergency exit locks the account until an admin reactivates it, and never deletes it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-lock-')), dataFile = path.join(dir, 'accounts.json');
  let time = Date.now(), server, base;
  async function start() { server = createTrinumServer({ dataFile, now: () => time, subscriptions: false, admin: { username: 'boss', password: 'boss-pass' } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function call(route, body, cookie) { const r = await fetch(base + '/api/' + route, { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
  async function saved() { return JSON.parse(await fs.readFile(dataFile, 'utf8')); }
  const credentials = { username: 'grace_user', name: 'Grace User', password: 'normal-password-123', emergencyPassword: 'emergency-password-123', confirmEmergencyPassword: 'emergency-password-123', emergencyAcknowledge: true };
  try {
    await start();
    let login = await call('register', credentials); const id = login.data.me.id;
    const exit = await call('emergency-exit', {}, login.cookie);
    assert.equal(exit.status, 200); assert.equal(exit.data.locked, true);
    assert.equal((await call('me', undefined, login.cookie)).status, 401);
    assert.equal((await call('login', credentials)).status, 403, 'The correct password cannot unlock it');
    time += 7 * 86400000; await stop(); await start();
    let stored = (await saved()).users.find(u => u.id === id);
    assert.ok(stored, 'Still stored after a week and a restart'); assert.equal(stored.suspended, true); assert.equal(stored.lockedReason, 'emergency');
    assert.equal((await call('login', credentials)).status, 403);

    const admin = await call('login', { username: 'boss', password: 'boss-pass' });
    const view = (await call('admin/overview', undefined, admin.cookie)).data.users.find(u => u.id === id);
    assert.equal(view.status, 'suspended'); assert.equal(view.lockedReason, 'emergency');
    assert.equal((await call('admin/suspend', { id, suspended: false }, admin.cookie)).status, 200);
    login = await call('login', credentials); assert.equal(login.status, 200);
    stored = (await saved()).users.find(u => u.id === id); assert.equal(stored.suspended, undefined); assert.equal(stored.lockedReason, undefined);

    // The main admin is only signed out; locking it would lock everyone out of the panel.
    const adminExit = await call('emergency-exit', {}, admin.cookie);
    assert.equal(adminExit.data.locked, false); assert.equal((await call('me', undefined, admin.cookie)).status, 401);
    assert.equal((await call('login', { username: 'boss', password: 'boss-pass' })).status, 200);

    // Accounts that were waiting for the old 30-minute deletion become locked instead.
    await stop(); await new Promise(r => setTimeout(r, 200)); // let the last sign-in write finish
    const data = await saved(); data.users.find(u => u.id === id).emergencyDeleteAt = time - 1; await fs.writeFile(dataFile, JSON.stringify(data));
    await start(); const until = Date.now() + 3000;
    do { stored = (await saved()).users.find(u => u.id === id); if (!stored.emergencyDeleteAt) break; await new Promise(r => setTimeout(r, 25)); } while (Date.now() < until);
    assert.equal(stored.emergencyDeleteAt, undefined); assert.equal(stored.suspended, true); assert.equal(stored.lockedReason, 'emergency');
  } finally { if (server?.listening) await stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrinumServer } = require('./server');

test('emergency grace period: recovery, expiration, restart and immediate session revocation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-grace-')), dataFile = path.join(dir, 'accounts.json');
  let time = Date.now(), server, base;
  async function start() { server = createTrinumServer({ dataFile, now: () => time }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function call(route, body, cookie) { const r = await fetch(base + '/api/' + route, { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
  async function saved() { return JSON.parse(await fs.readFile(dataFile, 'utf8')); }
  const credentials = { username: 'grace_user', name: 'Grace User', password: 'normal-password-123', emergencyPassword: 'emergency-password-123', confirmEmergencyPassword: 'emergency-password-123', emergencyAcknowledge: true };
  try {
    await start();
    let login = await call('register', credentials), id = login.data.me.id;
    const originalCookie = login.cookie;
    const exit = await call('emergency-exit', {}, originalCookie);
    assert.equal(exit.status, 200); assert.equal(exit.data.deletionScheduledAt, time + 30 * 60000);
    assert.equal((await call('me', undefined, originalCookie)).status, 401);
    assert.equal((await saved()).users[0].id, id);
    assert.equal((await call('login', { username: credentials.username, password: 'wrong' })).status, 401);
    assert.equal((await saved()).users[0].emergencyDeleteAt, exit.data.deletionScheduledAt);
    time = exit.data.deletionScheduledAt - 1;
    login = await call('login', credentials); assert.equal(login.status, 200);
    assert.equal((await saved()).users[0].emergencyDeleteAt, undefined);
    time += 60 * 60000;
    assert.equal((await call('me', undefined, login.cookie)).status, 200);
    const again = await call('emergency-exit', {}, login.cookie); const deadline = again.data.deletionScheduledAt;
    await stop(); await start();
    assert.equal((await saved()).users[0].emergencyDeleteAt, deadline, 'Deadline survives restart');
    time = deadline;
    assert.equal((await call('login', credentials)).status, 401, 'Correct normal password cannot recover at the deadline');
    assert.equal((await saved()).users.length, 0);
    login = await call('register', credentials);
    const third = await call('emergency-exit', {}, login.cookie);
    await stop(); time = third.data.deletionScheduledAt + 1; await start();
    await call('me');
    assert.equal((await saved()).users.length, 0, 'Overdue accounts are purged at startup');
    login = await call('register', credentials);
    const timed = await call('emergency-exit', {}, login.cookie);
    await stop(); time = timed.data.deletionScheduledAt - 20; await start();
    time = timed.data.deletionScheduledAt + 1;
    const until = Date.now() + 3000;
    while ((await saved()).users.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await saved()).users.length, 0, 'Timer deletes overdue accounts without another API request');
  } finally { if (server?.listening) await stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

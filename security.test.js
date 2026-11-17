const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrinumServer } = require('./server');

test('avatars and emergency-password account lock', { timeout: 20000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-security-')), dataFile = path.join(dir, 'accounts.json');
  const server = createTrinumServer({ dataFile, subscriptions: false }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port, normal = 'normal-password-123', emergency = 'emergency-password-456';
  const controllers = [];
  async function call(route, body, cookie) {
    const r = await fetch(base + '/api/' + route, { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(username) { return call('register', { username, name: username, password: normal, emergencyPassword: 'initial-emergency-password', confirmEmergencyPassword: 'initial-emergency-password', emergencyAcknowledge: true }); }
  try {
    let a = await register('avatar_user'), b = await register('friend_user'), c = await register('pending_user');
    const id = a.data.me.id, bid = b.data.me.id, cid = c.data.me.id;
    const valid = { currentPassword: normal, emergencyPassword: emergency, confirmPassword: emergency, acknowledge: true };
    await t.test('any password works; an optional emergency password must be distinct, confirmed and acknowledged', async () => {
      const body = { username: 'missing_security', name: 'Missing Security', password: normal };
      assert.equal((await call('register', { ...body, emergencyPassword: normal, confirmEmergencyPassword: normal, emergencyAcknowledge: true })).status, 400);
      for (const [username, password] of [['weak_one', '1'], ['weak_two', 'a'], ['weak_three', ' ']]) {
        const r = await call('register', { username, name: 'Weak', password }); assert.equal(r.status, 200, 'Any password, without an emergency password'); assert.equal(r.data.me.emergencyEnabled, false);
        assert.equal((await call('login', { username, password })).status, 200);
      }
      assert.equal((await call('register', { ...body, emergencyPassword: emergency, confirmEmergencyPassword: emergency, emergencyAcknowledge: false })).status, 400);
      assert.equal((await call('register', { ...body, emergencyPassword: emergency, confirmEmergencyPassword: 'not-the-same', emergencyAcknowledge: true })).status, 400);
    });
    await t.test('avatars require authentication; reject SVG and malformed data', async () => {
      assert.equal((await call('avatar', { remove: true })).status, 401);
      assert.equal((await call('avatar', { image: 'data:image/svg+xml;base64,PHN2Zz4=' }, a.cookie)).status, 400);
      assert.equal((await call('avatar', { image: 'data:image/jpeg;base64,aGVsbG8=' }, a.cookie)).status, 400);
      // Image-signature fixture; browser tests exercise an actual decoded image.
      const jpeg = Buffer.from([255,216,255,224,0,2,0,0,255,217]).toString('base64');
      const uploaded = await call('avatar', { image: 'data:image/jpeg;base64,' + jpeg }, a.cookie);
      assert.equal(uploaded.status, 200); assert.match(uploaded.data.me.avatar, /\/api\/avatar\?id=/);
      assert.equal((await fetch(base + uploaded.data.me.avatar)).status, 401);
      const image = await fetch(base + uploaded.data.me.avatar, { headers: { Cookie: b.cookie } }); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(jpeg, 'base64'));
      const search = await call('search?q=avatar', undefined, b.cookie); assert.equal(search.data.users[0].avatar, uploaded.data.me.avatar);
      assert.equal((await call('avatar', { remove: true }, a.cookie)).data.me.avatar, null);
      await call('avatar', { image: 'data:image/jpeg;base64,' + jpeg }, a.cookie);
    });
    await t.test('emergency setup requires normal password, confirmation and distinct credentials', async () => {
      assert.equal((await call('security', valid)).status, 401);
      assert.equal((await call('security', { ...valid, currentPassword: 'wrong' }, a.cookie)).status, 403);
      assert.equal((await call('security', { ...valid, acknowledge: false }, a.cookie)).status, 400);
      assert.equal((await call('security', { ...valid, confirmPassword: 'does-not-match' }, a.cookie)).status, 400);
      assert.equal((await call('security', { ...valid, emergencyPassword: normal, confirmPassword: normal }, a.cookie)).status, 400);
      const enabled = await call('security', valid, a.cookie); assert.equal(enabled.status, 200); assert.equal(enabled.data.me.emergencyEnabled, true);
      const saved = await fs.readFile(dataFile, 'utf8'); assert.ok(!saved.includes(emergency)); assert.ok(!saved.includes(normal));
      assert.equal(enabled.data.me.emergencyHash, undefined); assert.equal(enabled.data.me.emergencySalt, undefined);
      assert.equal((await call('security', { currentPassword: normal, remove: true }, a.cookie)).data.me.emergencyEnabled, false);
      assert.equal((await call('login', { username: 'avatar_user', password: emergency })).status, 401);
      assert.equal((await call('me', undefined, a.cookie)).status, 200);
      a = await call('login', { username: 'avatar_user', password: normal }); assert.equal(a.status, 200); assert.equal(a.data.accountLocked, undefined);
      assert.equal((await call('security', valid, a.cookie)).status, 200);
    });
    await t.test('emergency login locks the account, keeps its data and revokes its session', async () => {
      await call('request', { to: bid }, a.cookie); await call('answer', { to: id, accept: true }, b.cookie);
      await call('request', { to: cid }, a.cookie); await call('request', { to: cid }, b.cookie);
      const controller = new AbortController(); controllers.push(controller);
      const stream = await fetch(base + '/api/events', { headers: { Cookie: a.cookie }, signal: controller.signal });
      const reader = stream.body.getReader(); await reader.read();
      const deletion = await call('login', { username: 'avatar_user', password: emergency });
      assert.equal(deletion.status, 200); assert.equal(deletion.data.accountLocked, true); assert.equal(deletion.data.me, undefined);
      let revoked = ''; while (!revoked.includes('event: revoked')) { const r = await reader.read(); if (r.done) break; revoked += new TextDecoder().decode(r.value); } assert.match(revoked, /event: revoked/);
      assert.equal((await call('me', undefined, a.cookie)).status, 401);
      const locked = await call('login', { username: 'avatar_user', password: normal }); assert.equal(locked.status, 403); assert.match(locked.data.error, /locked/);
      assert.equal((await call('me', undefined, b.cookie)).data.friends.length, 1);
      const persisted = JSON.parse(await fs.readFile(dataFile, 'utf8')), me = persisted.users.find(u => u.id === id);
      assert.equal(persisted.users.length, 6); assert.equal(me.suspended, true); assert.equal(me.lockedReason, 'emergency');
    });
    await t.test('one-click exit revokes the session, locks the account and blocks cross-origin requests', async () => {
      const d = await register('exit_user'), did = d.data.me.id;
      await call('security', { currentPassword: normal, remove: true }, d.cookie);
      await call('request', { to: bid }, d.cookie); await call('answer', { to: did, accept: true }, b.cookie);
      await call('request', { to: cid }, d.cookie);
      assert.equal((await call('emergency-exit', {})).status, 401);
      assert.equal((await call('emergency-exit', undefined, d.cookie)).status, 404);
      const crossOrigin = await fetch(base + '/api/emergency-exit', { method: 'POST', headers: { Cookie: d.cookie, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(crossOrigin.status, 403); assert.equal((await call('me', undefined, d.cookie)).status, 200);
      const result = await call('emergency-exit', { to: bid }, d.cookie);
      assert.equal(result.status, 200); assert.equal(result.data.signedOut, true);
      assert.equal(result.data.locked, true);
      assert.equal((await call('me', undefined, d.cookie)).status, 401);
      assert.equal((await call('me', undefined, b.cookie)).status, 200);
      assert.equal((await call('me', undefined, b.cookie)).data.friends.length, 2);
      const saved = await fs.readFile(dataFile, 'utf8'); assert.ok(saved.includes(did)); assert.ok(saved.includes(bid)); assert.ok(saved.includes(cid));
      assert.equal((await call('login', { username: 'exit_user', password: normal })).status, 403);
      assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).users.find(u => u.id === did).lockedReason, 'emergency');
    });
  } finally { controllers.forEach(c => c.abort()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrinumServer } = require('./server');

test('accounts, directory, consent, presence, private signaling and persistence', { timeout: 20000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-test-'));
  const dataFile = path.join(dir, 'accounts.json');
  let server, base; const streams = [];
  async function start() { server = createTrinumServer({ dataFile }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { streams.forEach(s => s.controller.abort()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function call(route, body, cookie) {
    if (route === 'register' && body) body = { emergencyPassword: 'test-emergency-123', confirmEmergencyPassword: 'test-emergency-123', emergencyAcknowledge: true, ...body };
    const r = await fetch(base + '/api/' + route, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0], headers: r.headers };
  }
  async function stream(cookie) {
    const controller = new AbortController(); const r = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const result = { controller, next: async type => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (block.startsWith('event: ' + type + '\n')) return JSON.parse(block.split('\ndata: ')[1]); continue; }
        const value = await reader.read(); if (value.done) throw Error('Stream ended'); buffer += decoder.decode(value.value, { stream: true });
      }
    } };
    streams.push(result); return result;
  }
  try {
    await start();
    const password = 'a-secret-password-2026';
    let alice, bob, eve, aliceCookie, bobCookie;
    await t.test('login page and protected APIs', async () => {
      const r = await fetch(base + '/'); assert.equal(r.status, 200); const html = await r.text(); assert.match(html, /id="authPage"/); assert.match(html, /id="workspace" hidden/);
      assert.equal((await call('me')).status, 401); assert.equal((await call('search?q=al')).status, 401);
      assert.equal((await fetch(base + '/.data/accounts.json')).status, 404);
      assert.equal((await call('register', { name: 'Too short', username: 'short', password: '123' })).status, 400);
    });
    await t.test('registration hashes passwords and rejects duplicate usernames', async () => {
      const a = await call('register', { name: 'Alice Test', username: 'alice', password }); assert.equal(a.status, 200); alice = a.data.me; aliceCookie = a.cookie;
      assert.match(a.headers.get('set-cookie'), /HttpOnly/); assert.match(a.headers.get('set-cookie'), /SameSite=Strict/);
      const b = await call('register', { name: 'Bob Test', username: 'bob', password }); bob = b.data.me; bobCookie = b.cookie;
      eve = await call('register', { name: 'Eve Test', username: 'eve', password });
      assert.equal((await call('register', { name: 'Other', username: 'ALICE', password })).status, 409);
      assert.equal((await call('login', { username: 'alice', password: 'wrong' })).status, 401);
      const saved = await fs.readFile(dataFile, 'utf8'); assert.ok(!saved.includes(password)); assert.match(saved, /"hash"/);
    });
    await t.test('search by display name and username does not expose password hashes', async () => {
      const byName = await call('search?q=Bob%20Test', undefined, aliceCookie); assert.equal(byName.data.users[0].id, bob.id);
      const byUsername = await call('search?q=alice', undefined, bobCookie); assert.equal(byUsername.data.users[0].id, alice.id);
      assert.equal((await call('search?q=%40alice', undefined, bobCookie)).data.users[0].id, alice.id);
      assert.equal(byName.data.users[0].hash, undefined); assert.equal(byName.data.users[0].salt, undefined); assert.equal(byName.data.users[0].relationship, 'none');
      assert.equal((await call('search?q=a', undefined, bobCookie)).data.users.length, 0);
    });
    await t.test('requests persist offline; only the recipient can accept or decline', async () => {
      assert.equal((await call('signal', { to: bob.id, signal: {} }, aliceCookie)).status, 403);
      assert.equal((await call('request', { to: bob.id }, aliceCookie)).status, 200);
      assert.equal((await call('request', { to: bob.id }, aliceCookie)).status, 409);
      assert.equal((await call('answer', { to: bob.id, accept: true }, aliceCookie)).status, 403);
      assert.equal((await call('answer', { to: alice.id, accept: true }, eve.cookie)).status, 403);
      assert.equal((await call('me', undefined, bobCookie)).data.incoming[0].id, alice.id);
      assert.equal((await call('answer', { to: alice.id, accept: false }, bobCookie)).status, 200);
      assert.equal((await call('me', undefined, aliceCookie)).data.friends.length, 0);
      await call('request', { to: bob.id }, aliceCookie);
      assert.equal((await call('answer', { to: alice.id, accept: true }, bobCookie)).status, 200);
      assert.equal((await call('me', undefined, aliceCookie)).data.friends[0].id, bob.id);
      assert.equal((await call('me', undefined, bobCookie)).data.friends[0].id, alice.id);
      assert.equal((await call('connect', { to: bob.id }, aliceCookie)).status, 409);
    });
    await t.test('presence and consent-gated negotiation stream to the correct friend', async () => {
      const a = await stream(aliceCookie), b = await stream(bobCookie); await a.next('state'); await b.next('state');
      const state = await call('me', undefined, aliceCookie); assert.equal(state.data.friends[0].online, true);
      assert.equal((await call('connect', { to: bob.id }, eve.cookie)).status, 403);
      assert.equal((await call('connect', { to: bob.id }, aliceCookie)).status, 200);
      assert.equal((await a.next('connect')).initiator, true); const accepted = await b.next('connect'); assert.equal(accepted.initiator, false); assert.equal(accepted.id, alice.id);
      const signal = { description: { type: 'offer', sdp: 'test-negotiation' } };
      assert.equal((await call('signal', { to: bob.id, signal }, aliceCookie)).status, 200);
      assert.deepEqual((await b.next('signal')).signal, signal);
      assert.equal((await call('message', { to: bob.id, text: 'must-not-persist' }, aliceCookie)).status, 404);
      assert.ok(!(await fs.readFile(dataFile, 'utf8')).includes('test-negotiation'));
      assert.ok(!(await fs.readFile(dataFile, 'utf8')).includes('must-not-persist'));
      await call('logout', {}, bobCookie); assert.equal((await a.next('offline')).id, bob.id);
      assert.equal((await call('me', undefined, bobCookie)).status, 401);
      assert.equal((await call('me', undefined, aliceCookie)).data.friends[0].online, false);
    });
    await t.test('accounts and friends survive a server restart; sessions do not', async () => {
      await stop(); await start();
      assert.equal((await call('me', undefined, aliceCookie)).status, 401);
      const login = await call('login', { username: 'alice', password }); assert.equal(login.status, 200); assert.equal(login.data.friends[0].id, bob.id);
      assert.equal(login.data.friends[0].online, false);
    });
  } finally { if (server.listening) await stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

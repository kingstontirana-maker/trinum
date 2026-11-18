const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTrinumServer } = require('./server');

test('messages reach friends who are offline, are never written to disk and leave the server once delivered', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-mail-')), dataFile = path.join(dir, 'accounts.json'), mailFile = path.join(dir, 'mail.json');
  let server, base; const streams = [];
  async function start() { server = createTrinumServer({ dataFile, subscriptions: false }); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { streams.forEach(s => s.controller.abort()); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  async function call(route, body, cookie) {
    if (route === 'register') body = { emergencyPassword: 'e', confirmEmergencyPassword: 'e', emergencyAcknowledge: true, ...body };
    const r = await fetch(base + '/api/' + route, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  async function stream(cookie) {
    const controller = new AbortController(), r = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const s = { controller, async next(type) {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (block.startsWith('event: ' + type + '\n')) return JSON.parse(block.split('\ndata: ')[1]); continue; }
        const v = await reader.read(); if (v.done) throw Error('Stream ended'); buffer += decoder.decode(v.value, { stream: true });
      }
    } };
    streams.push(s); return s;
  }
  const saved = async () => server.pendingMail();
  const onDisk = async () => { const names = await fs.readdir(dir); return names.filter(n => n !== 'accounts.json' && !n.startsWith('accounts.json')); };
  try {
    await start();
    const a = await call('register', { username: 'mila', name: 'Mila', password: '1' }), b = await call('register', { username: 'noah', name: 'Noah', password: '1' }), c = await call('register', { username: 'zed', name: 'Zed', password: '1' });
    const mila = a.data.me.id, noah = b.data.me.id;
    await call('request', { to: noah }, a.cookie); await call('answer', { to: mila, accept: true }, b.cookie);

    await t.test('only friends can send', async () => {
      assert.equal((await call('relay', { to: noah, text: 'hi' }, c.cookie)).status, 403);
      assert.equal((await call('relay', { to: noah, text: 'hi' })).status, 401);
      assert.equal((await call('relay', { to: noah, text: '   ' }, a.cookie)).status, 400);
    });

    await t.test('offline recipient: messages wait in memory only and arrive in order', async () => {
      for (const text of ['one', 'two', 'three']) assert.equal((await call('relay', { to: noah, text }, a.cookie)).status, 200);
      const audio = Buffer.from('fake-audio-bytes').toString('base64');
      assert.equal((await call('relay', { to: noah, voice: { mime: 'audio/ogg; codecs=opus', duration: 2.5, data: audio } }, a.cookie)).status, 200);
      assert.equal((await call('relay', { to: noah, voice: { mime: 'text/html', duration: 1, data: audio } }, a.cookie)).status, 400);
      assert.equal(await saved(), 4);
      await new Promise(r => setTimeout(r, 200));
      assert.deepEqual(await onDisk(), [], 'No message file is written');
      const stored = await fs.readFile(dataFile, 'utf8'); assert.ok(!stored.includes('three') && !stored.includes(audio), 'No message text in the database');
      const noahLogin = await call('login', { username: 'noah', password: '1' });
      const s = await stream(noahLogin.cookie);
      const got = [await s.next('mail'), await s.next('mail'), await s.next('mail'), await s.next('mail')];
      assert.deepEqual(got.slice(0, 3).map(m => m.text), ['one', 'two', 'three']);
      assert.equal(got[3].voice.data, audio); assert.equal(got[3].from, mila);
      const milaLogin = await call('login', { username: 'mila', password: '1' }), ms = await stream(milaLogin.cookie);
      await ms.next('state');
      assert.equal((await call('ack', { ids: got.map(m => m.id) }, noahLogin.cookie)).status, 200);
      assert.equal((await ms.next('delivered')).to, noah);
      assert.equal(await saved(), 0);
      // Acknowledged messages are not sent again on reconnect.
      s.controller.abort(); const again = await stream(noahLogin.cookie); await again.next('state');
      await call('relay', { to: noah, text: 'live' }, milaLogin.cookie);
      assert.equal((await again.next('mail')).text, 'live');
    });

    await t.test('other users cannot acknowledge someone else’s mail', async () => {
      assert.equal(await saved(), 1);
      const noahLogin = await call('login', { username: 'noah', password: '1' }), s = await stream(noahLogin.cookie), pending = await s.next('mail');
      await call('ack', { ids: [pending.id] }, c.cookie); assert.equal(await saved(), 1);
    });

    await t.test('a restart forgets undelivered messages and removes an old mail.json', async () => {
      await stop(); await fs.writeFile(mailFile, JSON.stringify([{ id: 'old1', from: mila, to: noah, at: Date.now(), text: 'legacy' }]));
      await start();
      assert.equal(await saved(), 1, 'Old stored message moved into memory');
      assert.equal(await fs.stat(mailFile).then(() => true, () => false), false, 'mail.json deleted');
    });
  } finally { await stop().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); }
});

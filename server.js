const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scrypt = require('node:util').promisify(crypto.scrypt);

function createTrinumServer({ dataFile = path.join(__dirname, '.data', 'accounts.json'), now = Date.now } = {}) {
  let store = { users: [], requests: [] };
  if (fs.existsSync(dataFile)) store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const sessions = new Map(), attempts = new Map(), connecting = new Map();
  let writes = Promise.resolve();
  const emergencyGraceMs = 30 * 60 * 1000;
  let expiryTimer, expiryWork, closing = false;
  const persist = () => {
    const snapshot = JSON.stringify(store);
    const operation = writes.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
      await fs.promises.writeFile(dataFile + '.tmp', snapshot, { mode: 0o600 });
      await fs.promises.rename(dataFile + '.tmp', dataFile);
    });
    writes = operation; return operation;
  };
  const user = id => store.users.find(u => u.id === id);
  const online = id => [...sessions.values()].some(s => s.userId === id && s.stream && !s.stream.destroyed);
  const publicUser = u => ({ id: u.id, name: u.name, username: u.username, online: online(u.id), avatar: u.avatar ? `/api/avatar?id=${u.id}&v=${u.avatarVersion}` : null });
  const emit = (id, type, value) => {
    for (const s of sessions.values()) if (s.userId === id && s.stream && !s.stream.destroyed) s.stream.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const state = u => ({ me: { ...publicUser(u), emergencyEnabled: !!u.emergencyHash }, friends: u.friends.map(user).filter(Boolean).map(publicUser), incoming: store.requests.filter(r => r.to === u.id).map(r => publicUser(user(r.from))), outgoing: store.requests.filter(r => r.from === u.id).map(r => publicUser(user(r.to))) });
  const update = id => { const u = user(id); if (u) emit(id, 'state', state(u)); };
  const presence = id => { update(id); for (const friend of user(id)?.friends || []) update(friend); };
  function revoke(token) {
    const s = sessions.get(token); if (!s) return;
    sessions.delete(token);
    if (s.stream) { s.stream.write('event: revoked\ndata: {}\n\n'); s.stream.end(); }
    if (!online(s.userId)) {
      for (const friend of user(s.userId)?.friends || []) emit(friend, 'offline', { id: s.userId });
      presence(s.userId);
    }
  }
  async function deleteAccount(u) {
    const previous = structuredClone(store), deletedId = u.id;
    store.users = store.users.filter(x => x.id !== deletedId);
    for (const other of store.users) other.friends = other.friends.filter(id => id !== deletedId);
    store.requests = store.requests.filter(r => r.from !== deletedId && r.to !== deletedId);
    try { await persist(); } catch (e) { store = previous; throw e; }
    for (const [token, session] of sessions) if (session.userId === deletedId) revoke(token);
    for (const key of connecting.keys()) if (key.split(':').includes(deletedId)) connecting.delete(key);
    for (const other of store.users) { emit(other.id, 'account-removed', { id: deletedId }); update(other.id); }
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (closing) return;
    const deadlines = store.users.filter(u => Number.isFinite(u.emergencyDeleteAt)).map(u => u.emergencyDeleteAt);
    if (deadlines.length) {
      expiryTimer = setTimeout(() => sweepExpiredAccounts().catch(() => {}), Math.max(20, Math.min(2147483647, Math.min(...deadlines) - now())));
      expiryTimer.unref();
    }
  }
  function sweepExpiredAccounts() {
    if (expiryWork) return expiryWork;
    expiryWork = (async () => {
      for (const u of [...store.users]) if (Number.isFinite(u.emergencyDeleteAt) && u.emergencyDeleteAt <= now() && user(u.id) === u) await deleteAccount(u);
    })().finally(() => { expiryWork = null; scheduleExpiry(); });
    return expiryWork;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, 'http://localhost');
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const fail = (code, message) => { const e = new Error(message); e.status = code; throw e; };
    if (!url.pathname.startsWith('/api/')) {
      const file = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/platform.css': 'platform.css', '/assets/chat-landscape.svg': 'assets/chat-landscape.svg', '/voice.js': 'voice.js', '/app.js': 'app.js' }[url.pathname];
      if (!file) return json(404, { error: 'Not found.' });
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }
    try {
      await sweepExpiredAccounts();
      if (!['GET', 'POST'].includes(req.method)) fail(405, 'Method not allowed.');
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Origin not allowed.');
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > (url.pathname === '/api/avatar' ? 100000 : 65536)) fail(413, 'Request is too large.'); }
        try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'Invalid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid request.');
      }
      if (['/api/login', '/api/register'].includes(url.pathname) && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        let a = attempts.get(ip);
        if (!a || Date.now() - a.since > 600000) attempts.set(ip, a = { since: Date.now(), count: 0 });
        if (++a.count > 30) fail(429, 'Too many attempts. Try again in 10 minutes.');
        const username = String(body.username || '').trim().toLowerCase(), password = String(body.password || '');
        if (!/^[a-z0-9_]{3,24}$/.test(username) || password.length > 128) fail(400, 'Username must contain 3–24 letters, numbers or underscores.');
        let u = store.users.find(x => x.username === username);
        if (url.pathname === '/api/register') {
          const name = String(body.name || '').trim();
          if (name.length < 2 || name.length > 40) fail(400, 'Name must contain 2–40 characters.');
          if (password.length < 10) fail(400, 'Password must contain at least 10 characters.');
          const emergencyPassword = body.emergencyPassword;
          if (typeof emergencyPassword !== 'string' || emergencyPassword.length < 10 || emergencyPassword.length > 128) fail(400, 'Set an emergency password with 10–128 characters.');
          if (emergencyPassword === password) fail(400, 'Use different normal and emergency passwords.');
          if (emergencyPassword !== body.confirmEmergencyPassword || body.emergencyAcknowledge !== true) fail(400, 'Confirm your emergency password and acknowledge permanent deletion.');
          if (u) fail(409, 'This username is already taken.');
          if (store.users.length >= 10000) fail(503, 'Registration is temporarily closed.');
          const salt = crypto.randomBytes(16).toString('hex'), emergencySalt = crypto.randomBytes(16).toString('hex');
          const [normalKey, emergencyKey] = await Promise.all([scrypt(password, salt, 64), scrypt(emergencyPassword, emergencySalt, 64)]);
          const hash = normalKey.toString('hex'), emergencyHash = emergencyKey.toString('hex');
          if (store.users.some(x => x.username === username)) fail(409, 'This username is already taken.');
          u = { id: crypto.randomBytes(12).toString('hex'), username, name, salt, hash, emergencySalt, emergencyHash, friends: [] };
          store.users.push(u);
          try { await persist(); } catch (e) { store.users = store.users.filter(x => x.id !== u.id); throw e; }
        } else {
          const [hash, emergencyHash] = await Promise.all([scrypt(password, u?.salt || 'trinum-dummy-salt', 64), scrypt(password, u?.emergencySalt || 'trinum-emergency-dummy', 64)]);
          if (u && user(u.id) === u && Number.isFinite(u.emergencyDeleteAt) && u.emergencyDeleteAt <= now()) { await deleteAccount(u); fail(401, 'Incorrect username or password.'); }
          if (u && user(u.id) === u && u.emergencyHash && crypto.timingSafeEqual(emergencyHash, Buffer.from(u.emergencyHash, 'hex'))) {
            // Persist deletion before invalidating sessions or reporting success.
            await deleteAccount(u);
            res.setHeader('Set-Cookie', 'trinum=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
            return json(200, { accountDeleted: true });
          }
          if (!u || user(u.id) !== u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) fail(401, 'Incorrect username or password.');
          if (u.emergencyDeleteAt) {
            const deadline = u.emergencyDeleteAt; delete u.emergencyDeleteAt;
            try { await persist(); } catch (e) { u.emergencyDeleteAt = deadline; throw e; }
            scheduleExpiry();
          }
        }
        for (const [token, s] of sessions) if (s.userId === u.id) revoke(token);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { userId: u.id, expires: Date.now() + 86400000, count: 0, window: Date.now(), stream: null });
        res.setHeader('Set-Cookie', `trinum=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted || process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
        return json(200, state(u));
      }
      const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('trinum='))?.slice(7), s = sessions.get(token);
      if (!s || s.expires < Date.now()) { if (s) revoke(token); fail(401, 'Please sign in to your account again.'); }
      const u = user(s.userId);
      if (!u) fail(401, 'Please sign in again.');
      // Emergency exit must remain available even when ordinary requests are rate limited.
      if (url.pathname === '/api/emergency-exit' && req.method === 'POST') {
        u.emergencyDeleteAt = now() + emergencyGraceMs;
        // Revoke immediately; saving the grace-period deadline must not keep a session alive.
        for (const [key, session] of sessions) if (session.userId === u.id) revoke(key);
        res.setHeader('Set-Cookie', 'trinum=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        try { await persist(); } finally { scheduleExpiry(); }
        return json(200, { signedOut: true, deletionScheduledAt: u.emergencyDeleteAt });
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (s.stream) { s.stream.write('event: tab-replaced\ndata: {}\n\n'); s.stream.end(); } s.stream = res;
        res.write(`event: state\ndata: ${JSON.stringify(state(u))}\n\n`); presence(u.id);
        req.on('close', () => {
          if (s.stream !== res) return; s.stream = null;
          const timer = setTimeout(() => { if (!online(u.id)) { for (const id of u.friends) emit(id, 'offline', { id: u.id }); presence(u.id); } }, 5000); timer.unref();
        }); return;
      }
      if (Date.now() - s.window > 60000) { s.window = Date.now(); s.count = 0; }
      if (++s.count > 240) fail(429, 'Too many requests. Try again in a minute.');
      if (url.pathname === '/api/me' && req.method === 'GET') return json(200, state(u));
      if (url.pathname === '/api/avatar' && req.method === 'GET') {
        const owner = user(url.searchParams.get('id'));
        if (!owner?.avatar) fail(404, 'Avatar not found.');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Security-Policy': "default-src 'none'" });
        return res.end(Buffer.from(owner.avatar, 'base64'));
      }
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().replace(/^@/, '').toLowerCase().slice(0, 40);
        if (q.length < 2) return json(200, { users: [] });
        return json(200, { users: store.users.filter(x => x.id !== u.id && (x.name.toLowerCase().includes(q) || x.username.includes(q))).slice(0, 25).map(x => ({ ...publicUser(x), relationship: u.friends.includes(x.id) ? 'friend' : store.requests.some(r => r.from === u.id && r.to === x.id) ? 'outgoing' : store.requests.some(r => r.from === x.id && r.to === u.id) ? 'incoming' : 'none' })) });
      }
      if (req.method !== 'POST') fail(404, 'Not found.');
      if (url.pathname === '/api/logout') { revoke(token); res.setHeader('Set-Cookie', 'trinum=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(200, {}); }
      if (url.pathname === '/api/avatar') {
        let encoded = null;
        if (!body.remove) {
          if (typeof body.image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.image)) fail(400, 'Upload a JPEG image.');
          encoded = body.image.split(',')[1]; const bytes = Buffer.from(encoded, 'base64');
          if (bytes.length > 65536 || bytes.length < 10 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail(400, 'Invalid image. Choose an image under 64 KB after resizing.');
        }
        const old = { avatar: u.avatar, avatarVersion: u.avatarVersion };
        if (encoded) { u.avatar = encoded; u.avatarVersion = crypto.randomBytes(8).toString('hex'); } else { delete u.avatar; delete u.avatarVersion; }
        try { await persist(); } catch (e) { Object.assign(u, old); throw e; }
        presence(u.id); return json(200, state(u));
      }
      if (url.pathname === '/api/security') {
        if (!s.securityWindow || Date.now() - s.securityWindow > 600000) { s.securityWindow = Date.now(); s.securityAttempts = 0; }
        if (++s.securityAttempts > 10) fail(429, 'Too many password attempts. Try again in 10 minutes.');
        if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128) fail(400, 'Enter your normal password.');
        const normal = await scrypt(body.currentPassword, u.salt, 64);
        if (user(u.id) !== u || !sessions.has(token)) fail(401, 'Please sign in again.');
        if (!crypto.timingSafeEqual(normal, Buffer.from(u.hash, 'hex'))) fail(403, 'Your normal password is incorrect.');
        let emergencySalt, emergencyHash;
        if (!body.remove) {
          if (body.acknowledge !== true) fail(400, 'Acknowledge that emergency login permanently deletes your account.');
          if (typeof body.emergencyPassword !== 'string' || body.emergencyPassword.length < 10 || body.emergencyPassword.length > 128) fail(400, 'Emergency password must contain 10–128 characters.');
          if (body.emergencyPassword !== body.confirmPassword) fail(400, 'Emergency passwords do not match.');
          const same = await scrypt(body.emergencyPassword, u.salt, 64);
          if (crypto.timingSafeEqual(same, Buffer.from(u.hash, 'hex'))) fail(400, 'Use a different password from your normal password.');
          emergencySalt = crypto.randomBytes(16).toString('hex');
          emergencyHash = (await scrypt(body.emergencyPassword, emergencySalt, 64)).toString('hex');
        }
        if (user(u.id) !== u || !sessions.has(token)) fail(401, 'Please sign in again.');
        const old = { emergencySalt: u.emergencySalt, emergencyHash: u.emergencyHash };
        if (body.remove) { delete u.emergencySalt; delete u.emergencyHash; } else { u.emergencySalt = emergencySalt; u.emergencyHash = emergencyHash; }
        try { await persist(); } catch (e) { Object.assign(u, old); throw e; }
        update(u.id); return json(200, state(u));
      }
      const target = user(String(body.to || ''));
      if (!target || target.id === u.id) fail(404, 'User not found.');
      if (url.pathname === '/api/request') {
        if (u.friends.includes(target.id)) fail(409, 'You are already friends.');
        if (store.requests.some(r => (r.from === u.id && r.to === target.id) || (r.to === u.id && r.from === target.id))) fail(409, 'A friend request is already pending.');
        store.requests.push({ from: u.id, to: target.id });
        await persist(); update(u.id); update(target.id); return json(200, state(u));
      }
      if (url.pathname === '/api/answer') {
        const r = store.requests.find(r => r.from === target.id && r.to === u.id);
        if (!r) fail(403, 'You have no request from this user.');
        if (typeof body.accept !== 'boolean') fail(400, 'Invalid response.');
        store.requests = store.requests.filter(x => x !== r);
        if (body.accept) { u.friends.push(target.id); target.friends.push(u.id); }
        await persist(); update(u.id); update(target.id);
        emit(target.id, 'notice', { text: `${u.name} ${body.accept ? 'accepted' : 'declined'} your friend request.` }); return json(200, state(u));
      }
      if (!u.friends.includes(target.id)) fail(403, 'Accept the friend request before chatting.');
      if (!online(target.id)) fail(409, 'Your friend is offline. Chat when you are both online.');
      if (url.pathname === '/api/connect') {
        const key = [u.id, target.id].sort().join(':');
        if (Date.now() - (connecting.get(key) || 0) < 12000) return json(200, { waiting: true });
        connecting.set(key, Date.now()); emit(target.id, 'connect', { ...publicUser(u), initiator: false }); emit(u.id, 'connect', { ...publicUser(target), initiator: true }); return json(200, {});
      }
      if (url.pathname === '/api/signal') { if (!body.signal || typeof body.signal !== 'object') fail(400, 'Invalid signal.'); emit(target.id, 'signal', { id: u.id, signal: body.signal }); return json(200, {}); }
      fail(404, 'Not found.');
    } catch (e) { if (!res.headersSent) json(e.status || 500, { error: e.status ? e.message : 'A server error occurred. Please try again.' }); }
  });
  const cleanup = setInterval(() => {
    for (const [token, s] of sessions) { if (s.expires < Date.now()) revoke(token); else s.stream?.write(': heartbeat\n\n'); }
    for (const [ip, a] of attempts) if (Date.now() - a.since > 600000) attempts.delete(ip);
    for (const [key, time] of connecting) if (Date.now() - time > 30000) connecting.delete(key);
  }, 25000);
  cleanup.unref();
  sweepExpiredAccounts().catch(() => {});
  server.on('close', () => { closing = true; clearInterval(cleanup); clearTimeout(expiryTimer); }); return server;
}
if (require.main === module) createTrinumServer().listen(process.env.PORT || 3000, () => console.log('Trinum: http://localhost:' + (process.env.PORT || 3000)));
module.exports = { createTrinumServer };

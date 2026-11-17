const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scrypt = require('node:util').promisify(crypto.scrypt);

const MAX_PASSWORD = 1024;
// Calendar-month arithmetic in UTC; Jan 31 + 1 month = Feb 28/29.
function addMonths(ts, months) {
  const d = new Date(ts), day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); return d.getTime();
}
function createTrinumServer({ dataFile = path.join(__dirname, '.data', 'accounts.json'), now = Date.now, admin = null, price = 199, subscriptions = true, turn = null } = {}) {
  let store = { users: [], requests: [], payments: [] };
  if (fs.existsSync(dataFile)) store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  store.payments ||= [];
  // Mailbox for messages sent while no direct WebRTC channel is open. Each item is
  // deleted as soon as the recipient's browser acknowledges it.
  const mailFile = path.join(path.dirname(dataFile), 'mail.json');
  let mail = fs.existsSync(mailFile) ? JSON.parse(fs.readFileSync(mailFile, 'utf8')) : [];
  let mailWrites = Promise.resolve();
  const persistMail = () => {
    const snapshot = JSON.stringify(mail);
    const operation = mailWrites.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(mailFile), { recursive: true });
      await fs.promises.writeFile(mailFile + '.tmp', snapshot, { mode: 0o600 });
      await fs.promises.rename(mailFile + '.tmp', mailFile);
    });
    mailWrites = operation; return operation;
  };
  const isAdmin = u => u?.role === 'admin';
  // Status is derived from the stored deadline, so expiry needs no write.
  const subStatus = u => isAdmin(u) ? 'admin' : u.suspended ? 'suspended' : !subscriptions ? 'active' : u.paidUntil > now() ? 'active' : u.paidUntil ? 'expired' : 'pending';
  const hasAccess = u => ['admin', 'active'].includes(subStatus(u));
  const adminName = admin?.password ? String(admin.username || 'admin').trim().toLowerCase() : null;
  let adminChanged = false;
  if (adminName) {
    if (!/^[a-z0-9_]{3,24}$/.test(adminName)) throw Error('ADMIN_USERNAME must contain 3–24 letters, numbers or underscores.');
    let a = store.users.find(x => x.username === adminName);
    if (!a) { a = { id: crypto.randomBytes(12).toString('hex'), username: adminName, name: 'Administrator', friends: [], createdAt: now() }; store.users.push(a); adminChanged = true; }
    if (a.role !== 'admin') { a.role = 'admin'; adminChanged = true; }
    if (a.suspended) { delete a.suspended; adminChanged = true; }
    if (!a.salt || !crypto.timingSafeEqual(crypto.scryptSync(admin.password, a.salt, 64), Buffer.from(a.hash, 'hex'))) {
      a.salt = crypto.randomBytes(16).toString('hex'); a.hash = crypto.scryptSync(admin.password, a.salt, 64).toString('hex'); adminChanged = true;
    }
    if (a.emergencyDeleteAt || a.lockedReason) { delete a.emergencyDeleteAt; delete a.lockedReason; delete a.lockedAt; adminChanged = true; }
  }
  // Emergency exits used to delete accounts after 30 minutes; they now lock them until an admin reactivates them.
  for (const x of store.users) if (Number.isFinite(x.emergencyDeleteAt)) { if (!isAdmin(x)) { x.suspended = true; x.lockedReason = 'emergency'; x.lockedAt = x.emergencyDeleteAt - 30 * 60 * 1000; } delete x.emergencyDeleteAt; adminChanged = true; }
  const sessions = new Map(), attempts = new Map(), connecting = new Map();
  let writes = Promise.resolve();
  let closing = false;
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
  const state = u => ({ me: { ...publicUser(u), emergencyEnabled: !!u.emergencyHash, role: isAdmin(u) ? 'admin' : 'user', access: hasAccess(u), subscription: { status: subStatus(u), paidUntil: u.paidUntil || null, price } }, friends: u.friends.map(user).filter(Boolean).map(publicUser), incoming: store.requests.filter(r => r.to === u.id).map(r => publicUser(user(r.from))), outgoing: store.requests.filter(r => r.from === u.id).map(r => publicUser(user(r.to))) });
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
    mail = mail.filter(m => m.from !== deletedId && m.to !== deletedId); persistMail().catch(() => {});
    try { await persist(); } catch (e) { store = previous; throw e; }
    for (const [token, session] of sessions) if (session.userId === deletedId) revoke(token);
    for (const key of connecting.keys()) if (key.split(':').includes(deletedId)) connecting.delete(key);
    for (const other of store.users) { emit(other.id, 'account-removed', { id: deletedId }); update(other.id); }
  }
  // Pushes fresh state when a subscription lapses so open tabs lock without a reload.
  const accessCache = new Map();
  let accessTimer;
  function refreshAccess() {
    clearTimeout(accessTimer);
    for (const u of store.users) {
      const access = hasAccess(u);
      if (accessCache.has(u.id) && accessCache.get(u.id) !== access) presence(u.id);
      accessCache.set(u.id, access);
    }
    for (const id of accessCache.keys()) if (!user(id)) accessCache.delete(id);
    if (closing) return;
    const next = store.users.map(u => u.paidUntil).filter(t => t > now());
    if (next.length) { accessTimer = setTimeout(refreshAccess, Math.max(20, Math.min(2147483647, Math.min(...next) - now() + 50))); accessTimer.unref(); }
  }
  // Emergency exit and emergency sign-in lock the account; only an admin can reactivate it.
  // The configured main admin is only signed out, because a restart would unlock it anyway.
  async function emergencyLock(u) {
    for (const [key, session] of sessions) if (session.userId === u.id) revoke(key);
    if (u.username === adminName) return;
    const old = { suspended: u.suspended, lockedReason: u.lockedReason, lockedAt: u.lockedAt };
    u.suspended = true; u.lockedReason = 'emergency'; u.lockedAt = now();
    try { await persist(); } catch (e) { Object.assign(u, old); throw e; }
    refreshAccess(); for (const id of u.friends) update(id);
  }
  const adminView = x => {
    const paid = store.payments.filter(p => p.userId === x.id);
    return { id: x.id, username: x.username, name: x.name, role: isAdmin(x) ? 'admin' : 'user', envAdmin: x.username === adminName, status: subStatus(x), paidUntil: x.paidUntil || null, createdAt: x.createdAt || null, lastLoginAt: x.lastLoginAt || null, online: online(x.id), friends: x.friends.length, emergencyEnabled: !!x.emergencyHash, lockedReason: x.suspended ? x.lockedReason || 'admin' : null, lockedAt: x.suspended ? x.lockedAt || null : null, note: x.note || '', totalPaid: paid.reduce((sum, p) => sum + p.amount, 0), payments: paid.length, avatar: x.avatar ? `/api/avatar?id=${x.id}&v=${x.avatarVersion}` : null };
  };
  const overview = () => {
    const users = store.users.map(adminView), t = now(), monthStart = new Date(t); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const count = status => users.filter(x => x.status === status).length;
    const revenue = store.payments.reduce((sum, p) => sum + p.amount, 0);
    return {
      price, now: t, users, payments: [...store.payments].reverse().sort((a, b) => b.at - a.at),
      stats: { total: users.length, active: count('active'), expired: count('expired'), pending: count('pending'), suspended: count('suspended'), admins: count('admin'), online: users.filter(x => x.online).length,
        expiringSoon: users.filter(x => x.status === 'active' && x.paidUntil - t < 7 * 86400000).length, mrr: count('active') * price, revenue,
        revenueMonth: store.payments.filter(p => p.at >= monthStart.getTime()).reduce((sum, p) => sum + p.amount, 0) }
    };
  };
  const validateNewAccount = (username, name, password, fail) => {
    if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400, 'Username must contain 3–24 letters, numbers or underscores.');
    if (name.length < 2 || name.length > 40) fail(400, 'Name must contain 2–40 characters.');
    if (!password || password.length > MAX_PASSWORD) fail(400, 'Enter a password.');
    if (store.users.some(x => x.username === username)) fail(409, 'This username is already taken.');
  };
  const recordPayment = (target, months, amount, by, note) => {
    const payment = { id: crypto.randomBytes(8).toString('hex'), userId: target.id, username: target.username, name: target.name, months, amount, at: now(), by: by.username, note: String(note || '').slice(0, 200) };
    store.payments.push(payment); return payment;
  };
  async function adminRoute(route, method, body, me, json, fail) {
    if (route === 'overview' && method === 'GET') return json(200, overview());
    if (method !== 'POST') fail(404, 'Not found.');
    const previous = structuredClone(store);
    const save = async () => { try { await persist(); } catch (e) { store = previous; throw e; } refreshAccess(); };
    if (route === 'create-user') {
      const username = String(body.username || '').trim().toLowerCase(), name = String(body.name || '').trim(), password = String(body.password || '');
      validateNewAccount(username, name, password, fail);
      const months = Number(body.months || 0);
      if (!Number.isInteger(months) || months < 0 || months > 36) fail(400, 'Choose 0–36 months.');
      const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(password, salt, 64)).toString('hex');
      if (store.users.some(x => x.username === username)) fail(409, 'This username is already taken.');
      const created = { id: crypto.randomBytes(12).toString('hex'), username, name, salt, hash, friends: [], role: body.role === 'admin' ? 'admin' : 'user', createdAt: now() };
      if (months && created.role !== 'admin') { created.paidUntil = addMonths(now(), months); if (body.recordPayment !== false) recordPayment(created, months, months * price, me, 'Account created'); }
      store.users.push(created); await save(); return json(200, overview());
    }
    if (route === 'delete-payment') {
      const before = store.payments.length; store.payments = store.payments.filter(p => p.id !== body.id);
      if (store.payments.length === before) fail(404, 'Payment not found.');
      await save(); return json(200, overview());
    }
    const target = user(String(body.id || ''));
    if (!target) fail(404, 'User not found.');
    if (route === 'extend') {
      const months = Number(body.months);
      if (!Number.isInteger(months) || months < 1 || months > 36) fail(400, 'Choose 1–36 months.');
      const amount = body.amount === undefined || body.amount === null || body.amount === '' ? months * price : Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) fail(400, 'Enter a valid amount.');
      // Renewals stack on remaining time; lapsed accounts restart from today.
      target.paidUntil = addMonths(Math.max(now(), target.paidUntil || 0), months);
      if (body.recordPayment !== false) recordPayment(target, months, Math.round(amount * 100) / 100, me, body.note);
      await save(); return json(200, overview());
    }
    if (route === 'set-expiry') {
      if (body.paidUntil === null) delete target.paidUntil;
      else { const t = Number(body.paidUntil); if (!Number.isFinite(t) || t < 0 || t > 8.64e15) fail(400, 'Enter a valid date.'); target.paidUntil = t; }
      await save(); return json(200, overview());
    }
    if (route === 'expire') { target.paidUntil = now(); await save(); return json(200, overview()); }
    if (route === 'note') { target.note = String(body.note || '').slice(0, 500); await save(); return json(200, overview()); }
    if (target.id === me.id) fail(400, 'You cannot do this to your own account.');
    if (route === 'suspend') {
      if (typeof body.suspended !== 'boolean') fail(400, 'Invalid request.');
      if (body.suspended) { target.suspended = true; target.lockedReason = 'admin'; target.lockedAt = now(); } else { delete target.suspended; delete target.lockedReason; delete target.lockedAt; }
      await save();
      if (body.suspended) for (const [key, session] of sessions) if (session.userId === target.id) revoke(key);
      return json(200, overview());
    }
    if (route === 'sign-out') { for (const [key, session] of sessions) if (session.userId === target.id) revoke(key); return json(200, overview()); }
    if (route === 'reset-password') {
      const password = String(body.password || '');
      if (!password || password.length > MAX_PASSWORD) fail(400, 'Enter a password.');
      const salt = crypto.randomBytes(16).toString('hex'); target.salt = salt; target.hash = (await scrypt(password, salt, 64)).toString('hex');
      await save(); for (const [key, session] of sessions) if (session.userId === target.id) revoke(key);
      return json(200, overview());
    }
    if (route === 'role') {
      if (!['admin', 'user'].includes(body.role)) fail(400, 'Invalid role.');
      if (target.username === adminName) fail(400, 'The main administrator is set by the server configuration.');
      target.role = body.role; await save(); update(target.id); return json(200, overview());
    }
    if (route === 'delete') {
      if (target.username === adminName) fail(400, 'The main administrator is set by the server configuration.');
      await deleteAccount(target); refreshAccess(); return json(200, overview());
    }
    fail(404, 'Not found.');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, 'http://localhost');
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const fail = (code, message) => { const e = new Error(message); e.status = code; throw e; };
    if (!url.pathname.startsWith('/api/')) {
      const file = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/platform.css': 'platform.css', '/assets/chat-landscape.svg': 'assets/chat-landscape.svg', '/voice.js': 'voice.js', '/call.js': 'call.js', '/app.js': 'app.js', '/admin': 'admin.html', '/admin/': 'admin.html', '/admin.js': 'admin.js', '/admin.css': 'admin.css' }[url.pathname];
      if (!file) return json(404, { error: 'Not found.' });
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      // A missing file must not crash the server.
      return fs.createReadStream(path.join(__dirname, file)).on('error', () => { if (!res.headersSent) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); } res.end('Not found.'); }).pipe(res);
    }
    try {
      if (!['GET', 'POST'].includes(req.method)) fail(405, 'Method not allowed.');
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Origin not allowed.');
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > ({ '/api/avatar': 100000, '/api/relay': 2000000 }[url.pathname] || 65536)) fail(413, 'Request is too large.'); }
        try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'Invalid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid request.');
      }
      if (['/api/login', '/api/register'].includes(url.pathname) && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        let a = attempts.get(ip);
        if (!a || Date.now() - a.since > 600000) attempts.set(ip, a = { since: Date.now(), count: 0 });
        if (++a.count > 30) fail(429, 'Too many attempts. Try again in 10 minutes.');
        const username = String(body.username || '').trim().toLowerCase(), password = String(body.password || '');
        if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400, 'Username must contain 3–24 letters, numbers or underscores.');
        if (password.length > MAX_PASSWORD) fail(400, 'Password is too long.');
        let u = store.users.find(x => x.username === username);
        if (url.pathname === '/api/register') {
          const name = String(body.name || '').trim();
          if (name.length < 2 || name.length > 40) fail(400, 'Name must contain 2–40 characters.');
          if (!password) fail(400, 'Enter a password.');
          const emergencyPassword = body.emergencyPassword;
          if (typeof emergencyPassword !== 'string' || !emergencyPassword || emergencyPassword.length > MAX_PASSWORD) fail(400, 'Set an emergency password.');
          if (emergencyPassword === password) fail(400, 'Use different normal and emergency passwords.');
          if (emergencyPassword !== body.confirmEmergencyPassword || body.emergencyAcknowledge !== true) fail(400, 'Confirm your emergency password and acknowledge permanent deletion.');
          if (u) fail(409, 'This username is already taken.');
          if (store.users.length >= 10000) fail(503, 'Registration is temporarily closed.');
          const salt = crypto.randomBytes(16).toString('hex'), emergencySalt = crypto.randomBytes(16).toString('hex');
          const [normalKey, emergencyKey] = await Promise.all([scrypt(password, salt, 64), scrypt(emergencyPassword, emergencySalt, 64)]);
          const hash = normalKey.toString('hex'), emergencyHash = emergencyKey.toString('hex');
          if (store.users.some(x => x.username === username)) fail(409, 'This username is already taken.');
          u = { id: crypto.randomBytes(12).toString('hex'), username, name, salt, hash, emergencySalt, emergencyHash, friends: [], role: 'user', createdAt: now() };
          store.users.push(u);
          try { await persist(); } catch (e) { store.users = store.users.filter(x => x.id !== u.id); throw e; }
        } else {
          const [hash, emergencyHash] = await Promise.all([scrypt(password, u?.salt || 'trinum-dummy-salt', 64), scrypt(password, u?.emergencySalt || 'trinum-emergency-dummy', 64)]);
          if (u && user(u.id) === u && u.emergencyHash && crypto.timingSafeEqual(emergencyHash, Buffer.from(u.emergencyHash, 'hex'))) {
            await emergencyLock(u);
            res.setHeader('Set-Cookie', 'trinum=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
            return json(200, { accountLocked: true });
          }
          if (!u || user(u.id) !== u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) fail(401, 'Incorrect username or password.');
          if (u.suspended) fail(403, u.lockedReason === 'emergency' ? 'This account is locked after an emergency exit. Contact the administrator to reactivate it.' : 'This account has been suspended. Contact the administrator.');
        }
        u.lastLoginAt = now(); persist().catch(() => {});
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
        res.setHeader('Set-Cookie', 'trinum=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        await emergencyLock(u);
        return json(200, { signedOut: true, locked: u.username !== adminName });
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (s.stream) { s.stream.write('event: tab-replaced\ndata: {}\n\n'); s.stream.end(); } s.stream = res;
        // A new tab or sign-in starts fresh: earlier connection attempts with this user are stale.
        for (const key of connecting.keys()) if (key.split(':').includes(u.id)) connecting.delete(key);
        res.write(`event: state\ndata: ${JSON.stringify(state(u))}\n\n`); presence(u.id);
        for (const m of mail) if (m.to === u.id) res.write(`event: mail\ndata: ${JSON.stringify(m)}\n\n`);
        req.on('close', () => {
          if (s.stream !== res) return; s.stream = null;
          const timer = setTimeout(() => { if (!online(u.id)) { for (const id of u.friends) emit(id, 'offline', { id: u.id }); presence(u.id); } }, 5000); timer.unref();
        }); return;
      }
      if (Date.now() - s.window > 60000) { s.window = Date.now(); s.count = 0; }
      if (++s.count > 240) fail(429, 'Too many requests. Try again in a minute.');
      if (url.pathname === '/api/me' && req.method === 'GET') return json(200, state(u));
      if (url.pathname === '/api/ice' && req.method === 'GET') {
        // STUN finds direct routes; an optional TURN relay (coturn with use-auth-secret) covers strict networks.
        const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        if (turn?.urls?.length && turn.secret) {
          const username = Math.floor(Date.now() / 1000 + 12 * 3600) + ':' + u.id;
          iceServers.push({ urls: turn.urls, username, credential: crypto.createHmac('sha1', turn.secret).update(username).digest('base64') });
        }
        return json(200, { iceServers });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!isAdmin(u)) fail(403, 'Administrator access required.');
        return await adminRoute(url.pathname.slice(11), req.method, body, u, json, fail);
      }
      if (!hasAccess(u) && url.pathname !== '/api/logout') fail(402, 'Your subscription is not active. Contact the administrator to activate your account.');
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
        if (typeof body.currentPassword !== 'string' || body.currentPassword.length > MAX_PASSWORD) fail(400, 'Enter your normal password.');
        const normal = await scrypt(body.currentPassword, u.salt, 64);
        if (user(u.id) !== u || !sessions.has(token)) fail(401, 'Please sign in again.');
        if (!crypto.timingSafeEqual(normal, Buffer.from(u.hash, 'hex'))) fail(403, 'Your normal password is incorrect.');
        let emergencySalt, emergencyHash;
        if (!body.remove) {
          if (body.acknowledge !== true) fail(400, 'Acknowledge that emergency login permanently deletes your account.');
          if (typeof body.emergencyPassword !== 'string' || !body.emergencyPassword || body.emergencyPassword.length > MAX_PASSWORD) fail(400, 'Enter an emergency password.');
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
      if (url.pathname === '/api/ack') {
        if (!Array.isArray(body.ids) || body.ids.length > 1000) fail(400, 'Invalid request.');
        const ids = new Set(body.ids.map(String)), done = mail.filter(m => m.to === u.id && ids.has(m.id));
        if (done.length) {
          mail = mail.filter(m => !done.includes(m)); await persistMail();
          for (const m of done) emit(m.from, 'delivered', { id: m.id, to: u.id });
        }
        return json(200, {});
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
      if (url.pathname === '/api/relay') {
        const m = { id: crypto.randomBytes(12).toString('hex'), from: u.id, to: target.id, at: now() };
        if (body.voice) {
          const v = body.voice;
          if (!v || typeof v !== 'object' || typeof v.mime !== 'string' || v.mime.length > 100 || !/^audio\/[a-z0-9.+-]+(\s*;\s*[a-z0-9=.,"' +-]*)?$/i.test(v.mime)) fail(400, 'Invalid voice message.');
          if (typeof v.data !== 'string' || !v.data || v.data.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)) fail(400, 'Invalid voice message.');
          const duration = Number(v.duration); if (!Number.isFinite(duration) || duration <= 0 || duration > 61) fail(400, 'Invalid voice message.');
          m.voice = { mime: v.mime, duration, data: v.data };
        } else {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) fail(400, 'Write a message.');
          m.text = body.text;
        }
        mail.push(m); await persistMail();
        emit(target.id, 'mail', m);
        return json(200, { id: m.id, at: m.at, delivered: false });
      }
      if (!hasAccess(target)) fail(409, 'This person cannot chat right now.');
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
    refreshAccess();
  }, 25000);
  cleanup.unref();
  if (adminChanged) persist().catch(e => console.error('Could not save the administrator account:', e.message));
  refreshAccess();
  server.on('close', () => { closing = true; clearInterval(cleanup); clearTimeout(accessTimer); }); return server;
}
if (require.main === module) createTrinumServer({
  ...(process.env.DATA_DIR ? { dataFile: path.join(process.env.DATA_DIR, 'accounts.json') } : {}),
  admin: process.env.ADMIN_PASSWORD ? { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD } : null,
  price: Number(process.env.PLAN_PRICE) > 0 ? Number(process.env.PLAN_PRICE) : 199,
  turn: process.env.TURN_URLS && process.env.TURN_SECRET ? { urls: process.env.TURN_URLS.split(',').map(x => x.trim()).filter(Boolean), secret: process.env.TURN_SECRET } : null
}).listen(process.env.PORT || 3000, () => console.log('Trinum: http://localhost:' + (process.env.PORT || 3000)));
module.exports = { createTrinumServer };

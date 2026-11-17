'use strict';
const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
let account = null, view = 'chats', active = null, authMode = 'login', events = null;
let searchTimer, searchVersion = 0, onlineOnly = false, signalingReady = false, authBusy = false;
let emergencyExiting = false;
const peers = new Map(), unread = new Map(), drafts = new Map();
const voice = new TrinumVoice({ channel: id => peers.get(id)?.channel, received: (id, message) => addMessage(id, message, false), notice: text => toast(text) });
let voiceBusy = false;
function clearVoice() { voice.cancel(); $('voicePreview').pause(); $('voicePreview').removeAttribute('src'); $('voicePanel').hidden = true; voiceBusy = false; }
function releaseMessage(m) { if (m.voice) URL.revokeObjectURL(m.voice.url); }
function icon(name) { const s = document.createElementNS(svgNS, 'svg'), u = document.createElementNS(svgNS, 'use'); u.setAttribute('href', '#i-' + name); s.append(u); s.setAttribute('aria-hidden', 'true'); return s; }
function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function initials(name) { return name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase(); }
function color(id) { return parseInt(id.slice(-2), 16) % 5; }
function avatar(p) { const el = node('span', 'avatar'); fillAvatar(el, p); return el; }
function fillAvatar(el, p) {
  el.textContent = initials(p.name); el.className = el.className.replace(/\bcolor-\d\b|\bonline\b/g, '').trim() + ' color-' + color(p.id) + (p.online ? ' online' : '');
  if (p.avatar) { const img = document.createElement('img'); img.src = p.avatar; img.alt = ''; img.onerror = () => { img.remove(); }; el.append(img); }
}
function toast(text) { $('toastText').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 4800); }
async function api(route, body) {
  let r;
  try { r = await fetch('/api/' + route, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); }
  catch { throw Error('Unable to reach the server. Check your connection and try again.'); }
  let data; try { data = await r.json(); } catch { throw Error('Start Trinum with npm start and open http://localhost:3000.'); }
  if (!r.ok) { const e = Error(data.error || 'The request could not be completed.'); e.status = r.status; throw e; }
  return data;
}
function run(fn) { return e => { if (e?.type === 'submit') e.preventDefault(); Promise.resolve().then(() => fn(e)).catch(e => toast(e.message)); }; }
function setAuthMode(mode) {
  if (authBusy) return;
  authMode = mode; const register = mode === 'register';
  $('nameField').hidden = !register; $('fullName').required = register; $('passwordHint').hidden = !register;
  $('registerEmergencyFields').hidden = !register;
  for (const id of ['registerEmergency', 'registerEmergencyConfirm', 'registerEmergencyAck']) $(id).required = register;
  $('password').minLength = 1; $('password').autocomplete = register ? 'new-password' : 'current-password';
  for (const [id, selected] of [['loginTab', !register], ['registerTab', register]]) { $(id).classList.toggle('active', selected); $(id).setAttribute('aria-selected', selected); }
  $('authTitle').textContent = register ? 'Your circle starts here.' : 'Your private space.';
  $('authSubtitle').textContent = register ? 'A new profile. Connections you choose.' : 'Sign in and reconnect with your people.';
  $('authSubmit').querySelector('span').textContent = register ? 'Create my account' : 'Sign in to Trinum';
  $('authError').hidden = true;
}
$('loginTab').onclick = () => setAuthMode('login'); $('registerTab').onclick = () => setAuthMode('register');
$('togglePassword').onclick = () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('togglePassword').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); $('togglePassword').setAttribute('aria-pressed', String(show)); };
$('authForm').onsubmit = async e => {
  e.preventDefault(); if (authBusy) return; authBusy = true;
  $('authSubmit').disabled = true; $('authSubmit').querySelector('span').textContent = 'One moment…'; $('authError').hidden = true;
  try {
    const data = await api(authMode, { username: $('username').value.trim(), password: $('password').value, name: $('fullName').value.trim(), ...(authMode === 'register' ? { emergencyPassword: $('registerEmergency').value, confirmEmergencyPassword: $('registerEmergencyConfirm').value, emergencyAcknowledge: $('registerEmergencyAck').checked } : {}) });
    $('password').value = '';
    $('registerEmergency').value = ''; $('registerEmergencyConfirm').value = ''; $('registerEmergencyAck').checked = false;
    if (data.accountDeleted) { leaveApp('Your account has been permanently deleted.'); return; }
    enterApp(data);
  } catch (error) { $('authError').textContent = error.message; $('authError').hidden = false; }
  finally { authBusy = false; $('authSubmit').disabled = false; $('authSubmit').querySelector('span').textContent = authMode === 'register' ? 'Create my account' : 'Sign in to Trinum'; }
};
function closePeers() {
  clearVoice(); voice.close();
  for (const p of peers.values()) { p.messages.forEach(releaseMessage); clearTimeout(p.timeout); clearTimeout(p.typingTimer); p.pc?.close(); }
  peers.clear(); drafts.clear(); unread.clear(); active = null; $('message').value = ''; $('messages').replaceChildren();
  $('chatView').hidden = true; $('welcome').hidden = false; $('workspace').classList.remove('in-chat');
}
const money = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const longDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
function renderSubscription(me) {
  const s = me.subscription, admin = me.role === 'admin';
  $('adminLink').hidden = !admin; $('adminNav').hidden = !admin;
  $('subscriptionLine').hidden = admin || s.status !== 'active';
  if (s.status === 'active' && s.paidUntil) $('subscriptionLine').textContent = 'Subscription active until ' + longDate(s.paidUntil) + '.';
  $('paywallPrice').textContent = money(s.price);
  const expired = s.status === 'expired';
  $('paywallKicker').textContent = expired ? 'SUBSCRIPTION EXPIRED' : 'ACCOUNT PENDING';
  $('paywallTitle').textContent = expired ? 'Your subscription has ended.' : 'Activate your account.';
  $('paywallText').textContent = expired
    ? 'It expired on ' + longDate(s.paidUntil) + '. Renew for ' + money(s.price) + ' per month to continue chatting. Contact the administrator to pay.'
    : 'Welcome, ' + me.name + '. Access to Trinum costs ' + money(s.price) + ' per month. Contact the administrator to pay and activate your account.';
}
function leaveApp(message) {
  closePeers();
  events?.close(); events = null; signalingReady = false; account = null;
  $('paywall').hidden = true; $('workspace').hidden = true; $('workspace').classList.remove('in-chat'); $('authPage').hidden = false;
  $('emergencyBar').hidden = true;
  $('chatView').hidden = true; $('welcome').hidden = false; $('search').value = '';
  setAuthMode('login'); $('password').value = '';
  $('securityForm').reset(); $('avatarFile').value = '';
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  if (message) toast(message);
}
function enterApp(data) {
  try { sessionStorage.removeItem('trinum-emergency-signed-out'); } catch {}
  $('authPage').hidden = true; $('workspace').hidden = false; active = null; view = 'chats';
  $('emergencyBar').hidden = false; updateViewport();
  applyState(data); showView('chats'); startEvents();
  const s = data.me.subscription;
  if (s.status === 'active' && s.paidUntil && s.paidUntil - Date.now() < 3 * 86400000) toast('Your subscription ends on ' + longDate(s.paidUntil) + '. Contact the administrator to renew.');
}
function applyState(data) {
  const previous = account; account = data;
  renderSubscription(data.me);
  const locked = !data.me.access;
  if (locked && (!previous || previous.me.access)) { closePeers(); for (const d of document.querySelectorAll('dialog[open]')) d.close(); }
  if (!locked && previous && !previous.me.access) toast('Your subscription is active. Welcome to Trinum.');
  $('paywall').hidden = !locked; $('workspace').hidden = locked;
  $('greeting').textContent = 'WELCOME BACK, ' + data.me.name.toUpperCase();
  for (const id of ['profileButton', 'mobileAvatar', 'profileAvatar']) fillAvatar($(id), data.me);
  $('profileName').textContent = data.me.name; $('profileUsername').textContent = '@' + data.me.username;
  $('profileFriendCount').textContent = data.friends.length;
  $('removeAvatar').hidden = !data.me.avatar;
  $('emergencyStatus').textContent = data.me.emergencyEnabled ? 'Emergency password is enabled' : 'Emergency password is not set';
  $('disableEmergency').hidden = !data.me.emergencyEnabled;
  for (const badge of document.querySelectorAll('.request-badge')) { badge.hidden = !data.incoming.length; badge.textContent = data.incoming.length > 9 ? '9+' : data.incoming.length; }
  renderOnline(); renderList(); refreshChat();
  if (previous && data.incoming.length > previous.incoming.length) toast('You have a new friend request.');
  const current = data.friends.find(p => p.id === active), old = previous?.friends.find(p => p.id === active);
  if (current?.online && old && !old.online && signalingReady) connect(active).catch(e => toast(e.message));
}
function startEvents() {
  events?.close(); const stream = new EventSource('/api/events'); events = stream;
  stream.addEventListener('state', e => { if (events !== stream) return; signalingReady = true; applyState(JSON.parse(e.data)); });
  stream.addEventListener('connect', e => { if (account) createPeer(JSON.parse(e.data)).catch(e => toast(e.message)); });
  stream.addEventListener('signal', e => {
    const data = JSON.parse(e.data), p = peers.get(data.id); if (!p) return;
    p.signals = p.signals.then(() => handleSignal(p, data.signal)).catch(e => { p.status = 'Could not connect. Please try again.'; refreshChat(); });
  });
  stream.addEventListener('notice', e => toast(JSON.parse(e.data).text));
  stream.addEventListener('account-removed', e => {
    const id = JSON.parse(e.data).id, peer = peers.get(id);
    if (peer) { clearTimeout(peer.timeout); clearTimeout(peer.typingTimer); peer.pc?.close(); }
    peers.delete(id); unread.delete(id); drafts.delete(id);
    voice.drop(id); peer?.messages.forEach(releaseMessage);
    if (active === id) { clearVoice(); active = null; $('message').value = ''; $('messages').replaceChildren(); $('chatView').hidden = true; $('welcome').hidden = false; $('workspace').classList.remove('in-chat'); }
    renderList();
  });
  stream.addEventListener('offline', e => { const p = peers.get(JSON.parse(e.data).id); if (p) { p.pc?.close(); p.status = 'Offline'; refreshChat(); renderList(); } });
  stream.addEventListener('revoked', () => { if (!emergencyExiting) leaveApp('Your session ended or your account was opened on another device.'); });
  stream.addEventListener('tab-replaced', () => leaveApp('Trinum is open in another tab. Continue your conversations there.'));
  stream.onopen = () => { signalingReady = true; $('greeting').classList.remove('network-banner'); };
  stream.onerror = async () => {
    signalingReady = false; if (!account || events !== stream) return;
    $('greeting').textContent = 'RECONNECTING…'; $('greeting').classList.add('network-banner');
    try { await api('me'); } catch (e) { if (e.status === 401 && events === stream) leaveApp('Your session ended. Please sign in again.'); }
  };
}
function showView(next, { focus = false } = {}) {
  clearVoice();
  view = next; onlineOnly = false; $('search').value = ''; $('clearSearch').hidden = true; searchVersion++; clearTimeout(searchTimer);
  $('workspace').classList.remove('in-chat');
  const titles = { chats: ['Chats', 'ALL CONVERSATIONS', 'Search conversations…'], friends: ['Your friends', 'YOUR CIRCLE', 'Search friends…'], discover: ['Find people', 'SEARCH BY NAME OR USERNAME', 'Name or @username…'], requests: ['Requests', 'INCOMING REQUESTS', 'Search requests…'] };
  $('viewTitle').textContent = titles[next][0]; $('listLabel').textContent = titles[next][1]; $('search').placeholder = titles[next][2];
  $('onlineSection').hidden = next === 'discover' || next === 'requests';
  for (const b of document.querySelectorAll('[data-view]')) { const selected = b.dataset.view === next; b.classList.toggle('active', selected); b.setAttribute('aria-current', selected ? 'page' : 'false'); }
  renderList(); if (focus) $('search').focus();
}
for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => showView(b.dataset.view, { focus: b.dataset.view === 'discover' });
for (const id of ['newChat', 'findFriends']) $(id).onclick = () => showView('discover', { focus: true });
$('search').oninput = () => {
  $('clearSearch').hidden = !$('search').value; clearTimeout(searchTimer); searchVersion++;
  if (view === 'discover') { if ($('search').value.trim().length < 2) renderList(); else { $('listContent').replaceChildren(node('p', 'loading-state', 'Searching…')); searchTimer = setTimeout(searchPeople, 300); } }
  else renderList();
};
$('clearSearch').onclick = () => { $('search').value = ''; $('search').dispatchEvent(new Event('input')); $('search').focus(); };
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && account) { e.preventDefault(); showView('discover', { focus: true }); } });
function renderOnline() {
  if (!account) return; const friends = account.friends.filter(p => p.online), box = $('onlineFriends');
  $('onlineCount').textContent = friends.length + (friends.length === 1 ? ' friend' : ' friends'); box.replaceChildren();
  for (const p of friends) { const b = node('button', 'online-person'); b.title = p.name + ' — online'; b.append(avatar(p), node('span', '', p.name.split(' ')[0])); b.onclick = () => openChat(p.id); box.append(b); }
  if (!friends.length) { const p = node('p', 'online-empty'); p.append(node('span', 'status-dot'), document.createTextNode('Your online friends will appear here.')); box.append(p); }
}
function empty(iconName, title, text, action) {
  const el = node('div', 'empty-state'), mark = node('div', 'empty-icon'); mark.append(icon(iconName)); el.append(mark, node('h3', '', title), node('p', '', text));
  if (action) { const b = node('button', 'row-action', 'Find people'); b.onclick = () => showView('discover', { focus: true }); el.append(b); } return el;
}
function personRow(p, { subtitle, clickable = false, action, preview = false } = {}) {
  const row = node(clickable ? 'button' : 'div', 'person-row' + (active === p.id ? ' selected' : ''));
  const info = node('div', 'person-details'), heading = node('div', 'person-heading'); heading.append(node('h3', '', p.name));
  const peer = peers.get(p.id), last = peer?.messages.at(-1);
  if (preview && last) heading.append(node('span', 'person-time', new Date(last.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })));
  info.append(heading, node('p', '', subtitle ?? (preview && last ? (last.own ? 'You: ' : '') + last.text : '@' + p.username + ' · ' + (p.online ? 'Online' : 'Offline'))));
  row.append(avatar(p), info); if (action) row.append(action);
  if (preview && unread.get(p.id)) row.append(node('span', 'unread-count', unread.get(p.id)));
  if (clickable) row.onclick = () => openChat(p.id); return row;
}
function renderList() {
  if (!account) return;
  if (view === 'discover') { if ($('search').value.trim().length >= 2) { searchPeople(); return; } $('listContent').replaceChildren(empty('search', 'Your people are out there.', 'Enter at least 2 characters of a name or username to find someone.')); $('listCount').textContent = '0'; return; }
  const box = $('listContent'), q = $('search').value.trim().replace(/^@/, '').toLowerCase(), match = p => (p.name + ' ' + p.username).toLowerCase().includes(q);
  box.replaceChildren();
  if (view === 'requests') {
    const incoming = account.incoming.filter(match), outgoing = account.outgoing.filter(match); $('listCount').textContent = account.incoming.length;
    for (const p of incoming) {
      const card = node('div', 'request-card'); card.append(personRow(p, { subtitle: '@' + p.username + ' · Wants to be your friend' })); const actions = node('div', 'request-actions');
      for (const accept of [true, false]) { const b = node('button', 'row-action' + (accept ? '' : ' secondary')); b.append(icon(accept ? 'check' : 'close'), document.createTextNode(accept ? 'Accept' : 'Decline')); b.onclick = run(async () => { for (const x of actions.querySelectorAll('button')) x.disabled = true; try { applyState(await api('answer', { to: p.id, accept })); toast(accept ? 'You are now friends. Start a conversation!' : 'Request declined.'); } finally { for (const x of actions.querySelectorAll('button')) x.disabled = false; } }); actions.append(b); }
      card.append(actions); box.append(card);
    }
    if (!incoming.length) box.append(empty('bell', q ? 'No requests match this name.' : 'No pending requests.', 'When someone sends you a request, you decide who gets in.'));
    if (outgoing.length) { box.append(node('p', 'list-separator', 'SENT REQUESTS · ' + outgoing.length)); for (const p of outgoing) { const b = node('button', 'row-action secondary', 'Pending'); b.disabled = true; box.append(personRow(p, { subtitle: '@' + p.username, action: b })); } }
    return;
  }
  let people = account.friends.filter(match).filter(p => !onlineOnly || p.online);
  people.sort((a, b) => view === 'chats' ? (peers.get(b.id)?.messages.at(-1)?.time || 0) - (peers.get(a.id)?.messages.at(-1)?.time || 0) || Number(b.online) - Number(a.online) : Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  $('listCount').textContent = people.length;
  if (view === 'friends') { const filters = node('div', 'friend-summary'); for (const only of [false, true]) { const b = node('button', 'filter-chip' + (onlineOnly === only ? ' active' : ''), only ? 'Online · ' + account.friends.filter(p => p.online).length : 'All · ' + account.friends.length); b.onclick = () => { onlineOnly = only; renderList(); }; filters.append(b); } box.append(filters); }
  for (const p of people) box.append(personRow(p, { clickable: true, preview: view === 'chats' }));
  if (!people.length) box.append(empty(view === 'chats' ? 'chat' : 'users', q ? 'No friends found.' : onlineOnly ? 'Your friends are offline.' : 'Every connection starts with a hello.', q ? 'Use Find people to send a new friend request.' : onlineOnly ? 'They will appear here when they come online.' : 'Find someone by name or username and invite them into your circle.', !onlineOnly));
}
async function searchPeople() {
  if (view !== 'discover' || !account) return; const q = $('search').value.trim(); if (q.length < 2) return;
  const version = ++searchVersion;
  try {
    const result = await api('search?q=' + encodeURIComponent(q)); if (version !== searchVersion || view !== 'discover') return;
    const box = $('listContent'); box.replaceChildren(); $('listCount').textContent = result.users.length;
    for (const p of result.users) {
      const b = node('button', 'row-action');
      if (p.relationship === 'friend') { b.textContent = 'Chat'; b.onclick = () => openChat(p.id); }
      else if (p.relationship === 'outgoing') { b.textContent = 'Pending'; b.disabled = true; }
      else if (p.relationship === 'incoming') { b.textContent = 'View request'; b.onclick = () => showView('requests'); }
      else { b.textContent = '+ Invite'; b.onclick = run(async () => { b.disabled = true; try { applyState(await api('request', { to: p.id })); toast('Request sent to ' + p.name + '.'); } catch (e) { b.disabled = false; throw e; } }); }
      box.append(personRow(p, { action: b }));
    }
    if (!result.users.length) box.append(empty('search', 'No results for this name.', 'Try another name or the exact username.'));
  } catch (e) { if (version === searchVersion) { $('listContent').replaceChildren(empty('search', 'Search could not be completed.', e.message)); $('listCount').textContent = '0'; } }
}
function getPeer(id) {
  if (!peers.has(id)) peers.set(id, { id, messages: [], candidates: [], signals: Promise.resolve(), status: '', pc: null, channel: null, typing: false });
  return peers.get(id);
}
function openChat(id) {
  if (active !== id) clearVoice();
  if (!account?.friends.some(p => p.id === id)) return;
  if (view !== 'chats') showView('chats');
  if (active) drafts.set(active, $('message').value);
  active = id; unread.delete(id); const p = getPeer(id); $('message').value = drafts.get(id) || ''; resizeComposer();
  $('welcome').hidden = true; $('chatView').hidden = false; $('workspace').classList.add('in-chat');
  $('messages').replaceChildren(); for (const m of p.messages) drawMessage(m); refreshChat(); renderList(); scrollBottom();
  if (window.matchMedia('(max-width:620px)').matches && location.hash !== '#chat') history.pushState({ chat: true }, '', '#chat');
  connect(id).catch(e => { p.status = e.message; refreshChat(); });
}
function backToList() { clearVoice(); $('workspace').classList.remove('in-chat'); if (location.hash === '#chat') history.back(); }
$('backToList').onclick = backToList;
window.addEventListener('popstate', () => { if (location.hash !== '#chat') { clearVoice(); $('workspace').classList.remove('in-chat'); } });
if (location.hash === '#chat') history.replaceState(null, '', location.pathname);
function refreshChat() {
  if (!account || !active) return; const friend = account.friends.find(p => p.id === active); if (!friend) return;
  const p = getPeer(active), ready = p.channel?.readyState === 'open';
  fillAvatar($('chatAvatar'), friend); $('chatName').textContent = friend.name;
  $('chatStatus').textContent = ready ? 'Online · encrypted connection' : friend.online ? '@' + friend.username + ' · Online' : '@' + friend.username + ' · Offline';
  $('chatStatus').classList.toggle('connected', ready); $('message').disabled = !ready; $('send').disabled = !ready || !$('message').value.trim();
  $('sessionBadge').classList.toggle('connected', ready);
  $('recordVoice').disabled = !ready || voiceBusy || !!voice.recording;
  $('sendVoice').disabled = !ready || voiceBusy;
  if (!ready && voice.recording) clearVoice();
  $('sessionLabel').textContent = ready ? 'Encrypted · Secure session' : 'Private session';
  $('typing').hidden = !p.typing || !ready;
  const status = $('connectionStatus'); status.replaceChildren(); status.classList.toggle('ready', ready);
  status.textContent = ready ? 'Messages stay in your open tabs.' : !friend.online ? 'Your friend is offline. Chat when you are both online.' : p.status || 'Establishing your private connection…';
  if (!ready && friend.online && p.pc?.connectionState !== 'connecting' && p.pc?.connectionState !== 'new') { const b = node('button', 'retry-button', 'Reconnect'); b.onclick = run(async () => { p.status = ''; await connect(active, true); }); status.append(document.createTextNode(' '), b); }
}
async function connect(id, force = false) {
  const friend = account?.friends.find(p => p.id === id), p = getPeer(id);
  if (!friend?.online || !signalingReady) { refreshChat(); return; }
  if (!force && (p.channel?.readyState === 'open' || ['new', 'connecting'].includes(p.pc?.connectionState) || Date.now() - (p.requested || 0) < 12000)) return;
  if (!window.isSecureContext || !window.RTCPeerConnection) throw Error('For chat, use HTTPS or localhost in a browser with WebRTC support.');
  p.requested = Date.now(); p.status = 'Establishing your private connection…'; refreshChat(); await api('connect', { to: id });
}
async function createPeer(data) {
  const p = getPeer(data.id); clearTimeout(p.timeout); p.pc?.close();
  p.channel = null; p.typing = false; p.candidates = []; p.signals = Promise.resolve(); p.status = 'Establishing your private connection…';
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); p.pc = pc;
  pc.onicecandidate = e => { if (e.candidate && p.pc === pc) api('signal', { to: data.id, signal: { candidate: e.candidate } }).catch(() => {}); };
  pc.ondatachannel = e => { if (p.pc === pc) bindChannel(p, e.channel, pc); };
  pc.onconnectionstatechange = () => {
    if (p.pc !== pc) return;
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { p.status = 'Connection interrupted.'; p.typing = false; }
    refreshChat(); renderList();
  };
  p.timeout = setTimeout(() => { if (p.pc === pc && p.channel?.readyState !== 'open') { pc.close(); p.status = 'Could not connect. Try again or switch networks.'; refreshChat(); } }, 22000);
  refreshChat();
  if (data.initiator) { bindChannel(p, pc.createDataChannel('trinum'), pc); await pc.setLocalDescription(await pc.createOffer()); if (p.pc === pc) await api('signal', { to: data.id, signal: { description: pc.localDescription } }); }
}
async function handleSignal(p, signal) {
  const pc = p.pc; if (!pc || pc.signalingState === 'closed') return;
  if (signal.description) {
    await pc.setRemoteDescription(signal.description);
    for (const candidate of p.candidates) await pc.addIceCandidate(candidate); p.candidates = [];
    if (signal.description.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); await api('signal', { to: p.id, signal: { description: pc.localDescription } }); }
  } else if (signal.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate); else p.candidates.push(signal.candidate); }
}
function bindChannel(p, channel, pc) {
  p.channel = channel;
  channel.onopen = () => { if (p.pc !== pc) return; clearTimeout(p.timeout); p.status = ''; refreshChat(); renderList(); };
  channel.onclose = () => { if (p.pc !== pc) return; voice.drop(p.id); p.status = 'Connection closed. You can reconnect.'; p.typing = false; refreshChat(); };
  channel.onerror = () => { if (p.pc === pc) { p.status = 'The connection is unstable.'; refreshChat(); } };
  channel.onmessage = e => {
    if (p.pc !== pc || typeof e.data !== 'string' || e.data.length > 20000) return;
    let message; try { message = JSON.parse(e.data); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (voice.receive(p.id, message)) return;
    if (message.type === 'typing') { p.typing = !!message.value; clearTimeout(p.typingTimer); p.typingTimer = setTimeout(() => { p.typing = false; refreshChat(); }, 3500); refreshChat(); }
    if (message.type === 'message' && typeof message.text === 'string' && message.text.length <= 16000 && message.text.trim()) { addMessage(p.id, message.text, false); p.typing = false; refreshChat(); }
  };
}
function drawMessage(m) {
  const row = node('div', 'bubble-row' + (m.own ? ' own' : '')), bubble = node('div', 'bubble', m.voice ? '' : m.text), time = node('time', '', new Date(m.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  if (m.voice) { bubble.classList.add('voice-bubble'); bubble.append(node('div', 'voice-label', 'Voice message · ' + Math.round(m.voice.duration) + 's')); const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = m.voice.url; audio.setAttribute('aria-label', 'Voice message'); audio.onerror = () => { bubble.querySelector('.voice-label').textContent = 'Voice message · this browser cannot play this format'; }; bubble.append(audio); }
  time.dateTime = new Date(m.time).toISOString(); if (m.own) { time.append(icon('check')); const lock = icon('lock'); lock.classList.add('message-lock'); time.append(lock); }
  if (!m.own) { const friend = account?.friends.find(p => p.id === active); if (friend) { const a = avatar(friend); a.classList.add('message-avatar'); a.classList.remove('online'); row.append(a); } }
  bubble.append(time); row.append(bubble); $('messages').append(row);
}
function addMessage(id, text, own) {
  const p = getPeer(id), m = { ...(typeof text === 'string' ? { text } : text), own, time: Date.now() }; p.messages.push(m);
  let trimmed = false;
  while (p.messages.length > 500 || p.messages.reduce((sum, msg) => sum + (msg.voice?.size || 0), 0) > 16 * 1024 * 1024) { releaseMessage(p.messages.shift()); trimmed = true; }
  const visible = active === id && (!window.matchMedia('(max-width:620px)').matches || $('workspace').classList.contains('in-chat'));
  if (active === id) { if (trimmed) { $('messages').replaceChildren(); for (const message of p.messages) drawMessage(message); } else drawMessage(m); scrollBottom(); }
  if (!own && !visible) { unread.set(id, Math.min(99, (unread.get(id) || 0) + 1)); const friend = account?.friends.find(p => p.id === id); toast('New message from ' + (friend?.name || 'your friend')); }
  if (view === 'chats') renderList();
}
function scrollBottom() { requestAnimationFrame(() => { $('messageScroll').scrollTop = $('messageScroll').scrollHeight; }); }
function resizeComposer() { $('message').style.height = 'auto'; $('message').style.height = Math.min($('message').scrollHeight, 130) + 'px'; }
let lastTyping = 0;
$('recordVoice').onclick = async () => {
  if (voiceBusy || voice.recording || !active) return; const peer = active; voiceBusy = true; refreshChat();
  try {
    $('voicePanel').hidden = false; $('voiceRecording').hidden = false; $('voiceTimer').textContent = 'Opening microphone…'; $('voicePreview').hidden = true; $('sendVoice').hidden = true;
    await voice.start(peer, seconds => { $('voiceTimer').textContent = 'Recording ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' / 1:00'; }, () => {
      $('voiceRecording').hidden = true; $('voicePreview').hidden = !voice.draft; $('sendVoice').hidden = !voice.draft; if (voice.draft) $('voicePreview').src = voice.draft.url; else $('voicePanel').hidden = true; refreshChat();
    });
  } catch (e) { clearVoice(); toast(e.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser to record.' : e.message); }
  finally { voiceBusy = false; refreshChat(); }
};
$('stopVoice').onclick = () => voice.stop();
$('cancelVoice').onclick = () => { clearVoice(); refreshChat(); };
$('sendVoice').onclick = run(async () => { if (voiceBusy || !voice.draft) return; const peer = active; voiceBusy = true; refreshChat(); try { const message = await voice.send(peer); addMessage(peer, message, true); clearVoice(); } finally { voiceBusy = false; refreshChat(); } });
$('message').oninput = () => { resizeComposer(); refreshChat(); const p = peers.get(active); if (p?.channel?.readyState === 'open' && Date.now() - lastTyping > 1300) { lastTyping = Date.now(); try { p.channel.send(JSON.stringify({ type: 'typing', value: !!$('message').value })); } catch {} } };
$('message').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('composer').requestSubmit(); } };
$('composer').onsubmit = e => {
  e.preventDefault(); const p = peers.get(active), text = $('message').value.trim(); if (!text || p?.channel?.readyState !== 'open') return;
  if (p.channel.bufferedAmount > 1000000) return toast('The connection is busy. Try again shortly.');
  try { p.channel.send(JSON.stringify({ type: 'message', text })); addMessage(active, text, true); $('message').value = ''; drafts.delete(active); resizeComposer(); refreshChat(); }
  catch { toast('Message could not be sent. Please try again.'); }
};
for (const id of ['profileButton', 'mobileProfile']) $(id).onclick = () => $('profileDialog').showModal();
$('chatInfo').onclick = () => $('privacyDialog').showModal();
$('chatSearch').onclick = () => showView('discover', { focus: true });
$('chatSettings').onclick = () => $('profileDialog').showModal();
$('uploadAvatar').onclick = () => $('avatarFile').click();
$('avatarFile').onchange = run(async () => {
  const file = $('avatarFile').files[0]; if (!file) return;
  $('uploadAvatar').disabled = true; $('removeAvatar').disabled = true;
  try {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw Error('Choose a JPG, PNG or WebP image up to 5 MB.');
    const image = await createImageBitmap(file);
    try {
      if (image.width > 12000 || image.height > 12000) throw Error('Please choose a smaller image.');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d'), side = Math.min(image.width, image.height);
      ctx.fillStyle = '#0a1212'; ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
      applyState(await api('avatar', { image: canvas.toDataURL('image/jpeg', .82) })); toast('Your avatar has been updated.');
    } finally { image.close(); }
  } finally { $('avatarFile').value = ''; $('uploadAvatar').disabled = false; $('removeAvatar').disabled = false; }
});
$('removeAvatar').onclick = run(async () => { $('removeAvatar').disabled = true; try { applyState(await api('avatar', { remove: true })); toast('Avatar removed.'); } finally { $('removeAvatar').disabled = false; } });
$('openSecurity').onclick = () => { $('profileDialog').close(); $('securityForm').reset(); $('securityError').hidden = true; $('securityDialog').showModal(); };
async function saveSecurity(remove) {
  $('securityError').hidden = true; $('saveEmergency').disabled = true; $('disableEmergency').disabled = true;
  try {
    applyState(await api('security', { currentPassword: $('securityCurrent').value, emergencyPassword: $('securityEmergency').value, confirmPassword: $('securityConfirm').value, acknowledge: $('securityAcknowledge').checked, remove }));
    $('securityForm').reset(); toast(remove ? 'Emergency password disabled.' : 'Emergency password saved. Keep it separate from your normal password.');
  } catch (e) { $('securityError').textContent = e.message; $('securityError').hidden = false; }
  finally { $('saveEmergency').disabled = false; $('disableEmergency').disabled = false; }
}
$('securityForm').onsubmit = e => { e.preventDefault(); saveSecurity(false); };
$('disableEmergency').onclick = () => saveSecurity(true);
// Keep an action in the browser's dialog top layer as well as the fixed app bar.
for (const dialog of document.querySelectorAll('dialog')) {
  const button = node('button', 'emergency-action dialog-emergency', 'Emergency exit · sign out now');
  button.type = 'button'; button.title = 'Sign out and open YouTube now. Sign back in within 30 minutes to keep your account.';
  dialog.prepend(button);
}
for (const button of document.querySelectorAll('.emergency-action')) button.onclick = () => {
  if (!account || emergencyExiting) return;
  emergencyExiting = true;
  // A keepalive request continues during navigation; never wait on the response to exit.
  try { sessionStorage.setItem('trinum-emergency-signed-out', '1'); } catch {}
  try { new BroadcastChannel('trinum-session').postMessage('emergency-exit'); } catch {}
  let queued = false;
  try { queued = navigator.sendBeacon('/api/emergency-exit', new Blob(['{}'], { type: 'application/json' })); } catch {}
  if (!queued) fetch('/api/emergency-exit', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
  leaveApp(); $('authPage').hidden = true;
  window.location.replace('https://www.youtube.com/');
};
for (const b of document.querySelectorAll('.close-dialog')) b.onclick = () => b.closest('dialog').close();
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
$('paywallLogout').onclick = run(async () => { await api('logout', {}); leaveApp(); });
$('logout').onclick = run(async () => { $('logout').disabled = true; try { await api('logout', {}); leaveApp(); } finally { $('logout').disabled = false; } });
// Keep the composer above mobile keyboards, including browsers with overlay keyboards.
function updateViewport() { if (window.matchMedia('(max-width:620px)').matches && window.visualViewport) { const nav = document.querySelector('.mobile-nav'); const navHeight = $('workspace').hidden ? 72 : nav.getBoundingClientRect().height || 72; const barHeight = $('emergencyBar').hidden ? 0 : $('emergencyBar').getBoundingClientRect().height; $('conversation').style.height = Math.max(160, window.visualViewport.height - navHeight - barHeight) + 'px'; $('conversation').style.top = window.visualViewport.offsetTop + barHeight + 'px'; } else { $('conversation').style.height = ''; $('conversation').style.top = ''; } }
window.visualViewport?.addEventListener('resize', updateViewport); window.visualViewport?.addEventListener('scroll', updateViewport); window.addEventListener('resize', updateViewport); updateViewport();
let emergencySignedOut = false;
try { emergencySignedOut = sessionStorage.getItem('trinum-emergency-signed-out') === '1'; } catch {}
if (!emergencySignedOut) api('me').then(enterApp).catch(e => { if (e.status !== 401) { $('authError').textContent = e.message; $('authError').hidden = false; } });
try { const channel = new BroadcastChannel('trinum-session'); channel.onmessage = e => { if (e.data === 'emergency-exit') { try { sessionStorage.setItem('trinum-emergency-signed-out', '1'); } catch {} leaveApp(); } }; } catch {}
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

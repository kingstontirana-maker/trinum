// Dependency-free Chromium UI check. Set CHROME_PATH if Chromium is elsewhere.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createTrinumServer } = require('../server');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'trinum-browser-'));
  const artifacts = path.join(__dirname, '..', '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const server = createTrinumServer({ dataFile: path.join(temp, 'accounts.json'), subscriptions: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const executable = process.env.CHROME_PATH || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
  let chrome, ws;
  try {
    chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + path.join(temp, 'chrome'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(Error('Chromium startup timed out')), 20000);
      chrome.on('error', e => { clearTimeout(timeout); reject(e); });
      chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
      chrome.once('exit', code => { clearTimeout(timeout); reject(Error('Chromium exited: ' + code + ' ' + output.slice(-800))); });
    });
    ws = new WebSocket(endpoint); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0; const pending = new Map(), errors = [], navigationRequests = [], navigationDispositions = [];
    ws.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.id) { const request = pending.get(data.id); if (!request) return; pending.delete(data.id); clearTimeout(request.timeout); data.error ? request.reject(Error(JSON.stringify(data.error))) : request.resolve(data.result); }
      if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
      if (data.method === 'Page.frameRequestedNavigation') { navigationRequests.push(data.params.url); navigationDispositions.push(data.params.disposition); }
    };
    const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000); pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const evaluate = async (page, expression) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, page); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    async function wait(page, expression, description) { const until = Date.now() + 15000; while (Date.now() < until) { if (await evaluate(page, expression)) return; await delay(100); } console.log(await evaluate(page, `JSON.stringify({error:document.getElementById('authError')?.textContent,toast:document.getElementById('toastText')?.textContent,invalid:[...document.querySelectorAll(':invalid')].map(e=>e.id)})`)); throw Error('UI timeout: ' + description); }
    async function click(page, selector) { const box = await evaluate(page, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }, page); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }, page); }
    async function size(page, width, height = 844) { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 620 }, page); await cdp('Emulation.setTouchEmulationEnabled', { enabled: width <= 620 }, page); }
    async function page(width = 390) { const context = await cdp('Target.createBrowserContext'); const target = await cdp('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId }); const attached = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }); const id = attached.sessionId; await cdp('Page.enable', {}, id); await cdp('Runtime.enable', {}, id); await size(id, width); await cdp('Page.navigate', { url: origin }, id); await wait(id, `document.getElementById('authForm') && document.readyState === 'complete'`, 'login page'); return id; }
    async function screenshot(page, name) { const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page); await fs.writeFile(path.join(artifacts, name + '.png'), Buffer.from(r.data, 'base64')); }
    const alice = await page(), bob = await page();
    await screenshot(alice, 'login-mobile'); await size(alice, 1440, 1000); await screenshot(alice, 'login-desktop'); await size(alice, 390);
    const suffix = Date.now().toString().slice(-6), password = 'browser-test-password';
    async function register(page, name, username) {
      await click(page, '#registerTab');
      await evaluate(page, `document.getElementById('fullName').value=${JSON.stringify(name)};document.getElementById('username').value=${JSON.stringify(username)};document.getElementById('password').value=${JSON.stringify(password)};`);
      await evaluate(page, `document.getElementById('registerEmergency').value='initial-emergency-password';document.getElementById('registerEmergencyConfirm').value='initial-emergency-password';document.getElementById('registerEmergencyAck').checked=true;`);
      await click(page, '#authSubmit'); await wait(page, `!document.getElementById('workspace').hidden`, 'registration');
      await wait(page, `document.getElementById('greeting').textContent.includes(${JSON.stringify(name.toUpperCase())})`, 'profile loaded');
      assert.ok(await evaluate(page, `!document.getElementById('emergencyBar').hidden && document.getElementById('emergencyExit').getBoundingClientRect().top >= 0`), 'Emergency action visible when signed in');
    }
    await register(alice, 'Aria Kola', 'aria_' + suffix); await register(bob, 'Elio Deda', 'elio_' + suffix);
    await click(alice, '.mobile-nav [data-view="discover"]');
    await evaluate(alice, `document.getElementById('search').value='Elio';document.getElementById('search').dispatchEvent(new Event('input'));`);
    await wait(alice, `document.getElementById('listContent').textContent.includes('Elio Deda')`, 'name search result');
    await screenshot(alice, 'search-mobile'); await click(alice, '.person-row .row-action');
    await wait(alice, `document.getElementById('listContent').textContent.includes('Pending')`, 'invitation sent');
    await click(bob, '.mobile-nav [data-view="requests"]');
    await wait(bob, `document.querySelector('.request-card')`, 'incoming request'); await screenshot(bob, 'requests-mobile');
    await click(bob, '.request-actions button:first-child');
    await click(alice, '.mobile-nav [data-view="friends"]');
    await wait(alice, `document.getElementById('onlineCount').textContent === '1 friend'`, 'friend online');
    await screenshot(alice, 'friends-mobile');
    for (const width of [320, 360, 390, 430, 768, 1440]) {
      await size(alice, width, width > 620 ? 1000 : 844); await delay(100);
      assert.ok(await evaluate(alice, 'document.documentElement.scrollWidth <= innerWidth'), 'No horizontal page overflow at ' + width);
      assert.ok(await evaluate(alice, `document.querySelector('.list-content').getBoundingClientRect().height > 120`), 'Scrollable friends list at ' + width);
    }
    await size(alice, 390); await click(alice, '#listContent .person-row');
    await wait(alice, `document.getElementById('chatStatus').classList.contains('connected')`, 'encrypted data channel');
    await click(bob, '.mobile-nav [data-view="chats"]'); await click(bob, '#listContent .person-row');
    await wait(bob, `document.getElementById('chatStatus').classList.contains('connected')`, 'recipient encrypted data channel');
    // The composer must be the topmost element at its own centre, so taps reach it.
    const composerHit = page => evaluate(page, `(()=>{const m=document.getElementById('message'),r=m.getBoundingClientRect(),e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return e===m?'ok':(e?e.tagName+'#'+e.id+'.'+e.className:'none')+' '+JSON.stringify(r)})()`);
    for (const width of [390, 1440]) { await size(alice, width, width > 620 ? 1000 : 844); await delay(150); assert.equal(await composerHit(alice), 'ok', 'Message field is clickable at ' + width); }
    await size(alice, 390);
    await evaluate(alice, `document.getElementById('message').value='Hey! Just between us.';document.getElementById('message').dispatchEvent(new Event('input'));document.getElementById('composer').requestSubmit();`);
    await wait(bob, `document.getElementById('messages').textContent.includes('Hey! Just between us.')`, 'message delivered');
    await evaluate(bob, `document.getElementById('message').value='Always. Welcome to Trinum ✨';document.getElementById('message').dispatchEvent(new Event('input'));document.getElementById('composer').requestSubmit();`);
    await wait(alice, `document.getElementById('messages').textContent.includes('Always.')`, 'reply delivered');
    await click(alice, '#recordVoice');
    await wait(alice, `document.getElementById('voiceTimer').textContent.startsWith('Recording ')`, 'microphone recording');
    await delay(3100); await click(alice, '#stopVoice');
    await wait(alice, `!document.getElementById('sendVoice').hidden && document.getElementById('voicePreview').readyState >= 1`, 'voice preview ready');
    assert.equal(await evaluate(alice, `voice.recording`), null, 'Recorder and microphone stopped after preview');
    await click(alice, '#sendVoice');
    await wait(bob, `document.querySelector('#messages audio')?.readyState >= 1`, 'voice message received and decodable');
    await evaluate(bob, `document.querySelector('#messages audio').play()`);
    assert.ok(await evaluate(bob, `!document.querySelector('#messages audio').paused`), 'Voice playback works');
    await evaluate(bob, `document.querySelector('#messages audio').pause()`);
    await click(alice, '#recordVoice'); await wait(alice, `voice.recording !== null`, 'second recording'); await click(alice, '#cancelVoice');
    await wait(alice, `document.getElementById('voicePanel').hidden && voice.recording === null`, 'discard stops recording');
    await size(alice, 390, 500); await delay(150);
    assert.ok(await evaluate(alice, `document.getElementById('composer').getBoundingClientRect().bottom <= visualViewport.height`), 'Composer remains in reduced keyboard viewport');
    await screenshot(alice, 'chat-keyboard-viewport'); await size(alice, 390);
    await screenshot(alice, 'chat-mobile');
    await size(alice, 1440, 1000); await screenshot(alice, 'chat-desktop'); await size(alice, 390);
    await click(alice, '#backToList'); await wait(alice, `!document.getElementById('workspace').classList.contains('in-chat')`, 'back navigation');
    await click(alice, '#mobileProfile');
    const avatarPNG = await evaluate(alice, `(()=>{const c=document.createElement('canvas');c.width=c.height=80;const x=c.getContext('2d');x.fillStyle='#00c9a7';x.fillRect(0,0,80,80);x.fillStyle='#00362d';x.font='bold 38px sans-serif';x.fillText('A',26,54);return c.toDataURL('image/png').split(',')[1];})()`);
    const avatarFile = path.join(temp, 'test-avatar.png'); await fs.writeFile(avatarFile, Buffer.from(avatarPNG, 'base64'));
    const doc = await cdp('DOM.getDocument', {}, alice), fileInput = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#avatarFile' }, alice);
    await cdp('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [avatarFile] }, alice);
    await wait(alice, `document.querySelector('#profileAvatar img')?.naturalWidth > 0`, 'uploaded avatar renders');
    await screenshot(alice, 'profile-mobile'); await click(alice, '#profileDialog .close-dialog');
    await cdp('Page.reload', {}, alice); await wait(alice, `document.getElementById('workspace') && !document.getElementById('workspace').hidden`, 'restored login');
    await wait(alice, `document.getElementById('listContent').textContent.includes('Elio Deda')`, 'persistent friendship');
    assert.equal(await evaluate(alice, `document.getElementById('messages').textContent`), '', 'Refresh clears messages');
    await click(alice, '#mobileProfile'); await click(alice, '#logout');
    await wait(alice, `!document.getElementById('authPage').hidden`, 'logout returns to login');
    // Offline delivery: Bob writes and records while Aria is signed out.
    await wait(bob, `!document.getElementById('chatStatus').classList.contains('connected')`, 'direct channel closed after logout');
    assert.ok(await evaluate(bob, `!document.getElementById('message').disabled`), 'Message field usable while friend is offline');
    await evaluate(bob, `document.getElementById('message').value='Sent while you were away';document.getElementById('message').dispatchEvent(new Event('input'));document.getElementById('composer').requestSubmit();`);
    await wait(bob, `document.getElementById('messages').textContent.includes('Sent while you were away')`, 'offline message shown to sender');
    await click(bob, '#recordVoice'); await wait(bob, `voice.recording !== null`, 'offline recording'); await delay(1500); await click(bob, '#stopVoice');
    await wait(bob, `!document.getElementById('sendVoice').hidden`, 'offline voice preview'); await click(bob, '#sendVoice');
    await wait(bob, `document.getElementById('voicePanel').hidden && document.querySelectorAll('#messages audio').length === 2`, 'offline voice sent');
    await evaluate(alice, `document.getElementById('username').value=${JSON.stringify('aria_' + suffix)};document.getElementById('password').value='wrong-password';`);
    await click(alice, '#authSubmit'); await wait(alice, `!document.getElementById('authError').hidden`, 'invalid login error');
    await evaluate(alice, `document.getElementById('password').value=${JSON.stringify(password)};`); await click(alice, '#authSubmit');
    await wait(alice, `!document.getElementById('workspace').hidden`, 'password login');
    await wait(alice, `document.getElementById('toastText').textContent === 'New message from Elio Deda'`, 'offline message delivered on sign-in');
    await click(alice, '#listContent .person-row');
    await wait(alice, `document.getElementById('messages').textContent.includes('Sent while you were away') && document.querySelector('#messages audio')?.readyState >= 1`, 'offline text and voice delivered');
    await delay(500); assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'mail.json'), 'utf8')).length, 0, 'Delivered messages removed from the server');
    // Video call: Bob calls, Aria answers, both see live video, Aria hangs up.
    await wait(bob, `document.getElementById('chatStatus').classList.contains('connected')`, 'chat reconnected before call');
    await click(bob, '#videoCall');
    await wait(alice, `!document.getElementById('callView').hidden && !document.getElementById('callIncoming').hidden && document.getElementById('callStatus').textContent === 'Incoming video call'`, 'incoming video call rings');
    await screenshot(alice, 'call-incoming-mobile');
    await click(alice, '#callAccept');
    for (const [who, name] of [[alice, 'Aria'], [bob, 'Bob']]) await wait(who, `document.getElementById('callView').classList.contains('phase-active') && document.getElementById('remoteVideo').videoWidth > 0 && document.getElementById('localVideo').videoWidth > 0`, name + ' sees live video');
    // Voice changer: the call sends the processed track, and the voice button switches presets live.
    assert.ok(await evaluate(bob, `TrinumVoiceFx.chains.size === 1 && calls.call.local.getAudioTracks()[0].label !== 'Fake Default Audio Input'`), 'Call audio goes through the voice changer');
    await click(bob, '#callVoice'); await click(bob, '#callVoice'); await click(bob, '#callVoice');
    assert.ok(await evaluate(bob, `TrinumVoiceFx.current === 'child' && document.getElementById('callVoiceLabel').textContent === 'Child' && [...TrinumVoiceFx.chains][0].pitch.parameters.get('ratio').value > 1.7`), 'Voice button switches to the child voice');
    const pitches = await evaluate(bob, `(async () => {
      const out = {};
      for (const [name, ratio, formant] of [['deep', 0.88, 0.95], ['female', 1.5, 1.15], ['child', 1.8, 1.28]]) {
        const ctx = new OfflineAudioContext(1, 48000, 48000); await ctx.audioWorklet.addModule('voice-fx.js');
        const osc = ctx.createOscillator(); osc.frequency.value = 220; const node = new AudioWorkletNode(ctx, 'trinum-pitch'); node.parameters.get('ratio').value = ratio; node.parameters.get('formant').value = formant;
        osc.connect(node); node.connect(ctx.destination); osc.start(); const data = (await ctx.startRendering()).getChannelData(0);
        const sums = []; for (let lag = 0; lag < 400; lag++) { let sum = 0; for (let i = 8000; i < 40000; i++) sum += data[i] * data[i + lag]; sums.push(sum); } const top = Math.max(...sums.slice(40)); let bestLag = 40; for (let lag = 41; lag < 399; lag++) if (sums[lag] > 0.8 * top && sums[lag] >= sums[lag - 1] && sums[lag] >= sums[lag + 1]) { bestLag = lag; break; }
        out[name] = 48000 / bestLag;
      }
      return out; })()`);
    assert.ok(Math.abs(pitches.deep - 220 * 0.88) < 12 && Math.abs(pitches.female - 220 * 1.5) < 15 && Math.abs(pitches.child - 220 * 1.8) < 20, 'Pitch shifter output: ' + JSON.stringify(pitches));
    await screenshot(bob, 'call-voice-child');
    await evaluate(bob, `TrinumVoiceFx.set('normal')`);
    // Face filter: the detector loads under the CSP; with Mask or Blur only the filtered canvas is
    // sent; with no face in view (the fake camera has none) the whole picture is hidden.
    assert.ok(await evaluate(bob, `TrinumVideoFx.load().then(d => !!d)`), 'Face detector loads from Trinum itself');
    assert.ok(await evaluate(bob, `calls.call.pc.getSenders().find(s => s.track && s.track.kind === 'video').track === calls.call.raw`), 'Normal sends the camera');
    await click(bob, '#callFace'); await click(bob, '#callFace');
    await wait(bob, `TrinumVideoFx.current === 'blur' && !!calls.call.pipe && calls.call.pc.getSenders().find(s => s.track && s.track.kind === 'video').track === calls.call.pipe.track`, 'Blur face sends only the filtered track');
    assert.ok(await evaluate(bob, `(async () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d'); g.fillStyle = '#7a8a90'; g.fillRect(0, 0, 640, 480);
      const keep = setInterval(() => g.fillRect(0, 0, 640, 480), 66), feed = c.captureStream(15), pipe = TrinumVideoFx.create(feed.getVideoTracks()[0]);
      await new Promise(r => setTimeout(r, 1500)); const ok = pipe.state.covered === 'all' && pipe.canvas.width === 640;
      pipe.destroy(); clearInterval(keep); feed.getTracks().forEach(t => t.stop()); return ok; })()`), 'No face in view: the whole picture is hidden');
    await click(bob, '#callFace'); await click(bob, '#callFace');
    await wait(bob, `TrinumVideoFx.current === 'mask' && !!calls.call.pipe && calls.call.pc.getSenders().find(s => s.track && s.track.kind === 'video').track === calls.call.pipe.track && calls.call.pipe.track.readyState === 'live'`, 'Mask mode sends the live filtered track');
    // Rapid taps must still end with the filtered track on the call.
    for (let i = 0; i < 7; i++) await evaluate(bob, `TrinumVideoFx.next()`);
    await evaluate(bob, `TrinumVideoFx.set('mask')`); await delay(600);
    assert.ok(await evaluate(bob, `calls.faceQueue.then(() => !!calls.call.pipe && calls.call.pc.getSenders().find(s => s.track && s.track.kind === 'video').track === calls.call.pipe.track && calls.call.pipe.track.readyState === 'live')`), 'After rapid taps the camera is still hidden');
    await wait(alice, `document.getElementById('callView').classList.contains('remote-on')`, 'remote video back after switching to Mask'); await delay(1500); await screenshot(alice, 'call-face-mask-remote');
    if (process.env.TRINUM_FACE_IMAGE) {
      // A real portrait: the face must be found and its area left with no detail.
      const photo = 'data:image/jpeg;base64,' + (await fs.readFile(process.env.TRINUM_FACE_IMAGE)).toString('base64');
      const detail = await evaluate(bob, `(async () => {
        const img = new Image(); img.src = ${JSON.stringify(photo)}; await img.decode();
        const src = document.createElement('canvas'); src.width = img.width; src.height = img.height; const sctx = src.getContext('2d'); sctx.drawImage(img, 0, 0);
        const feed = src.captureStream(15), keep = setInterval(() => sctx.drawImage(img, 0, 0), 66);
        const results = {};
        for (const mode of ['blur', 'mask']) {
          TrinumVideoFx.set(mode); const pipe = TrinumVideoFx.create(feed.getVideoTracks()[0]); const until = Date.now() + 15000;
          while (pipe.state.covered !== 'face' && Date.now() < until) await new Promise(r => setTimeout(r, 50));
          await new Promise(r => setTimeout(r, 300));
          const b = pipe.state.boxes[0], w = pipe.canvas.width, h = pipe.canvas.height;
          const sharp = c => { const d = c.getContext('2d').getImageData(Math.round(b.originX), Math.round(b.originY), Math.round(b.width), Math.round(b.height)).data, W = Math.round(b.width); let sum = 0, n = 0; for (let i = 4; i < d.length; i += 4) { if ((i / 4) % W === 0) continue; sum += Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2]); n++; } return sum / n; };
          results[mode] = { covered: pipe.state.covered, faces: pipe.state.faces, before: sharp(src), after: sharp(pipe.canvas), box: [b.originX, b.originY, b.width, b.height].map(Math.round), size: [w, h] };
          if (mode === 'mask') { const shot = document.createElement('canvas'); shot.width = 320; shot.height = 400; shot.getContext('2d').drawImage(pipe.canvas, 0, 0, 320, 400); results.preview = shot.toDataURL('image/jpeg', 0.8); }
          else { const shot = document.createElement('canvas'); shot.width = 320; shot.height = 400; shot.getContext('2d').drawImage(pipe.canvas, 0, 0, 320, 400); results.blurPreview = shot.toDataURL('image/jpeg', 0.8); }
          pipe.destroy();
        }
        clearInterval(keep); feed.getTracks().forEach(t => t.stop()); return results; })()`);
      await fs.writeFile(path.join(artifacts, 'face-mask.jpg'), Buffer.from(detail.preview.split(',')[1], 'base64'));
      await fs.writeFile(path.join(artifacts, 'face-blur.jpg'), Buffer.from(detail.blurPreview.split(',')[1], 'base64'));
      console.log('face filter', JSON.stringify({ blur: detail.blur, mask: detail.mask }));
      for (const mode of ['blur', 'mask']) {
        assert.equal(detail[mode].covered, 'face', mode + ': face found in the portrait');
        assert.ok(detail[mode].after < detail[mode].before * (mode === 'mask' ? 0.4 : 0.2), mode + ': no detail left in the face area ' + JSON.stringify(detail[mode]));
      }
    }
    await evaluate(bob, `TrinumVideoFx.set('normal')`);
    await wait(bob, `!calls.call.pipe && calls.call.pc.getSenders().find(s => s.track && s.track.kind === 'video').track === calls.call.raw`, 'Back to Normal sends the camera again');
    await click(bob, '#callMute'); assert.ok(await evaluate(bob, `calls.call.local.getAudioTracks()[0].enabled === false && document.getElementById('callMute').classList.contains('off')`), 'Mute disables the microphone');
    await delay(1200); await screenshot(bob, 'call-video-mobile'); await size(bob, 1440, 1000); await screenshot(bob, 'call-video-desktop'); await size(bob, 390);
    await click(alice, '#callEnd');
    for (const [who, name] of [[alice, 'Aria'], [bob, 'Bob']]) await wait(who, `document.getElementById('callView').hidden && document.getElementById('messages').textContent.includes('Video call · ')`, name + ' call ended and logged');
    assert.ok(await evaluate(bob, `document.getElementById('remoteVideo').srcObject === null && calls.call === null`), 'Call resources released');
    // Voice call that is declined.
    await click(alice, '#voiceCall');
    await wait(bob, `!document.getElementById('callIncoming').hidden && document.getElementById('callStatus').textContent === 'Incoming voice call'`, 'incoming voice call rings');
    await click(bob, '#callDecline');
    await wait(alice, `document.getElementById('callView').hidden && document.getElementById('toastText').textContent.includes('declined')`, 'declined call ends for caller');
    await click(bob, '#voiceCall');
    await wait(alice, `!document.getElementById('callIncoming').hidden`, 'second voice call rings'); await click(alice, '#callAccept');
    for (const [who, name] of [[alice, 'Aria'], [bob, 'Bob']]) await wait(who, `document.getElementById('callView').classList.contains('phase-active') && document.getElementById('callView').classList.contains('voice') && document.getElementById('callCamera').hidden`, name + ' in voice call');
    await screenshot(alice, 'call-voice-mobile'); await click(bob, '#callEnd');
    await wait(alice, `document.getElementById('callView').hidden`, 'voice call ended');
    await click(alice, '#backToList');
    await click(alice, '#mobileProfile'); await click(alice, '[data-voice="deep"]'); assert.ok(await evaluate(alice, `TrinumVoiceFx.current === 'deep' && document.querySelector('[data-voice="deep"]').getAttribute('aria-checked') === 'true'`), 'Profile voice picker'); await screenshot(alice, 'voice-picker'); await click(alice, '[data-voice="normal"]'); await click(alice, '#openSecurity');
    const emergency = 'temporary-emergency-789';
    await evaluate(alice, `document.getElementById('securityCurrent').value=${JSON.stringify(password)};document.getElementById('securityEmergency').value=${JSON.stringify(emergency)};document.getElementById('securityConfirm').value=${JSON.stringify(emergency)};document.getElementById('securityAcknowledge').checked=true;`);
    await screenshot(alice, 'security-mobile'); await click(alice, '#saveEmergency');
    await wait(alice, `document.getElementById('emergencyStatus').textContent === 'Emergency password is enabled' && document.getElementById('securityCurrent').value === ''`, 'emergency password saved');
    await click(alice, '#securityDialog .close-dialog'); await click(alice, '#mobileProfile'); await click(alice, '#logout');
    await wait(alice, `!document.getElementById('authPage').hidden`, 'sign out before emergency login');
    await evaluate(alice, `document.getElementById('username').value=${JSON.stringify('aria_' + suffix)};document.getElementById('password').value=${JSON.stringify(emergency)};`);
    await click(alice, '#authSubmit');
    await wait(alice, `document.getElementById('toastText').textContent === 'This account is locked. Contact the administrator to reactivate it.'`, 'emergency login locks account');
    assert.ok(await evaluate(alice, `document.getElementById('workspace').hidden`), 'Emergency login does not open a session');
    assert.ok(await evaluate(alice, `document.getElementById('emergencyBar').hidden`), 'Emergency action hidden when signed out');
    // PrintScreen blurs the conversation behind the privacy shield; clicking the shield brings it back.
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PrintScreen', code: 'PrintScreen', windowsVirtualKeyCode: 44 }, bob);
    await wait(bob, `document.body.classList.contains('shielded') && !document.getElementById('privacyShield').hidden && getComputedStyle(document.getElementById('workspace')).filter.includes('blur')`, 'PrintScreen shows the privacy shield');
    await screenshot(bob, 'privacy-shield');
    await evaluate(bob, `document.getElementById('privacyShield').click()`);
    await wait(bob, `!document.body.classList.contains('shielded')`, 'shield dismissed');
    assert.equal(await evaluate(bob, `getComputedStyle(document.getElementById('emergencyBar')).filter`), 'none', 'Emergency bar never blurred');
    // Block external loading while verifying immediate replacement navigation to Temu.
    const pagesBeforeExit = (await cdp('Target.getTargets')).targetInfos.filter(t => t.type === 'page').length;
    await cdp('Network.enable', {}, bob); await cdp('Network.setBlockedURLs', { urls: ['*://www.temu.com/*'] }, bob);
    await click(bob, '#backToList'); await click(bob, '#mobileProfile');
    await click(bob, '#profileDialog .dialog-emergency');
    const exitDeadline = Date.now() + 10000; while (!navigationRequests.includes('https://www.temu.com/') && Date.now() < exitDeadline) await delay(100);
    assert.ok(navigationRequests.includes('https://www.temu.com/'), 'Emergency button immediately redirects to Temu');
    assert.equal(navigationDispositions[navigationRequests.indexOf('https://www.temu.com/')], 'currentTab', 'Temu opens in the same tab, not a new one');
    assert.equal((await cdp('Target.getTargets')).targetInfos.filter(t => t.type === 'page').length, pagesBeforeExit, 'No new tab was opened');
    const graceDeadline = Date.now() + 5000; let remaining;
    do { remaining = JSON.parse(await fs.readFile(path.join(temp, 'accounts.json'), 'utf8')).users.find(u => u.username === 'elio_' + suffix); if (remaining?.lockedReason) break; await delay(100); } while (Date.now() < graceDeadline);
    assert.equal(remaining?.lockedReason, 'emergency', 'Navigation keepalive request locked the account');
    await cdp('Page.navigate', { url: origin }, bob);
    await wait(bob, `document.getElementById('authPage') && !document.getElementById('authPage').hidden`, 'Returning after emergency exit requires sign-in');
    assert.equal(await evaluate(bob, `fetch('/api/me').then(r=>r.status)`), 401, 'Session revoked despite immediate navigation');
    await evaluate(bob, `document.getElementById('username').value=${JSON.stringify('elio_' + suffix)};document.getElementById('password').value=${JSON.stringify(password)};`);
    await click(bob, '#authSubmit'); await wait(bob, `!document.getElementById('authError').hidden && document.getElementById('authError').textContent.includes('locked')`, 'Locked account cannot sign in');
    assert.ok(await evaluate(bob, `document.getElementById('workspace').hidden`), 'Locked account stays signed out');
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    const stored = await fs.readFile(path.join(temp, 'accounts.json'), 'utf8'); assert.ok(!stored.includes('Hey!')); assert.ok(!stored.includes('Always.')); assert.ok(stored.includes('aria_' + suffix)); assert.ok(stored.includes('elio_' + suffix)); assert.ok(!stored.includes('emergencyDeleteAt')); assert.ok(!stored.includes(emergency));
    console.log('PASS: login, registration, search, invitations, WebRTC messages, mobile layouts, avatar upload, emergency password setup and emergency lock on a temporary test account; screenshots in .artifacts/');
    await cdp('Browser.close').catch(() => {});
  } finally {
    ws?.close(); if (chrome && !chrome.killed) chrome.kill();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // Chromium can retain profile handles briefly after exit.
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

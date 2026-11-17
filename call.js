'use strict';
// Voice and video calls between friends. Media travels peer to peer over WebRTC (encrypted
// with DTLS-SRTP); the server only relays the call signals through /api/signal.
class TrinumCalls {
  constructor({ api, iceServers, friend, toast, log, onChange }) {
    Object.assign(this, { api, iceServers, friend, toast, log, onChange: onChange || (() => {}) });
    this.call = null; this.queue = Promise.resolve();
    const $ = id => document.getElementById(id); this.$ = $;
    $('callAccept').onclick = () => this.accept().catch(e => this.fail(e));
    $('callDecline').onclick = () => this.hangup();
    $('callEnd').onclick = () => this.hangup();
    $('callMute').onclick = () => this.toggle('audio');
    $('callCamera').onclick = () => this.toggle('video');
    $('callFlip').onclick = () => this.flip().catch(() => this.toast('Could not switch the camera.'));
  }
  get busy() { return !!this.call; }
  send(peer, message) { return this.api('signal', { to: peer, signal: { call: message } }); }

  async media(video, facing = 'user') {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw Error('Calls need HTTPS and a browser with camera and microphone support.');
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try { return await navigator.mediaDevices.getUserMedia({ audio, video: video ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false }); }
    catch (e) {
      if (video) { try { const s = await navigator.mediaDevices.getUserMedia({ audio }); this.toast('Camera unavailable. Continuing with voice only.'); return s; } catch {} }
      throw Error(e?.name === 'NotAllowedError' ? 'Allow microphone' + (video ? ' and camera' : '') + ' access in your browser to call.' : 'No microphone' + (video ? ' or camera' : '') + ' was found.');
    }
  }

  async start(peer, video) {
    if (this.call) return this.toast('You are already in a call.');
    const friend = this.friend(peer); if (!friend) return;
    if (!friend.online) return this.toast(friend.name + ' is offline. Calls work when you are both online.');
    const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    const call = this.call = { id, peer, video, role: 'caller', phase: 'outgoing', candidates: [], facing: 'user' };
    this.show();
    try {
      call.local = await this.media(video);
      if (this.call !== call) { call.local.getTracks().forEach(t => t.stop()); return; }
      call.video = call.local.getVideoTracks().length > 0; this.show();
      await this.send(peer, { type: 'invite', id, video: call.video });
      if (this.call !== call) return;
      this.tone('ringback'); call.timer = setTimeout(() => { if (this.call === call && call.phase === 'outgoing') { this.send(peer, { type: 'end', id }).catch(() => {}); this.finish('No answer.', 'No answer'); } }, 45000);
    } catch (e) { if (this.call === call) this.finish(e.message); }
  }

  // Signals arrive in order through the app's event stream.
  handle(from, message) { this.queue = this.queue.then(() => this.process(from, message)).catch(e => this.fail(e)); }
  async process(from, m) {
    if (!m || typeof m.id !== 'string' || m.id.length > 64) return;
    const call = this.call;
    if (m.type === 'invite') {
      if (!this.friend(from)) return;
      if (call) {
        // Both pressed call at once: the smaller id wins, the other side becomes the callee.
        if (call.peer === from && call.phase === 'outgoing' && call.id > m.id) this.finish(null);
        else { if (!(call.peer === from && call.phase === 'outgoing')) this.send(from, { type: 'busy', id: m.id }).catch(() => {}); return; }
      }
      const incoming = this.call = { id: m.id, peer: from, video: !!m.video, role: 'callee', phase: 'incoming', candidates: [], facing: 'user' };
      this.show(); this.tone('ring'); try { navigator.vibrate?.([400, 300, 400, 300, 400]); } catch {}
      incoming.timer = setTimeout(() => { if (this.call === incoming && incoming.phase === 'incoming') this.finish('Missed ' + (incoming.video ? 'video' : 'voice') + ' call.', 'Missed ' + (incoming.video ? 'video' : 'voice') + ' call'); }, 45000);
      return;
    }
    if (!call || call.id !== m.id || call.peer !== from) return;
    if (m.type === 'accept' && call.role === 'caller' && call.phase === 'outgoing') {
      clearTimeout(call.timer); this.tone(null); call.phase = 'connecting'; this.show();
      const pc = this.connection(call);
      await pc.setLocalDescription(await pc.createOffer());
      await this.send(from, { type: 'offer', id: call.id, description: pc.localDescription });
    } else if (m.type === 'offer' && call.role === 'callee' && call.pc && m.description?.type === 'offer') {
      await call.pc.setRemoteDescription(m.description); await this.flush(call);
      await call.pc.setLocalDescription(await call.pc.createAnswer());
      await this.send(from, { type: 'answer', id: call.id, description: call.pc.localDescription });
    } else if (m.type === 'answer' && call.role === 'caller' && call.pc && m.description?.type === 'answer') {
      await call.pc.setRemoteDescription(m.description); await this.flush(call);
    } else if (m.type === 'candidate' && m.candidate) {
      if (call.pc?.remoteDescription) await call.pc.addIceCandidate(m.candidate).catch(() => {}); else if (call.candidates.length < 200) call.candidates.push(m.candidate);
    } else if (m.type === 'decline') this.finish((this.friend(from)?.name || 'Your friend') + ' declined the call.', 'Call declined');
    else if (m.type === 'busy') this.finish((this.friend(from)?.name || 'Your friend') + ' is in another call.');
    else if (m.type === 'end') this.finish(call.phase === 'incoming' ? 'Missed ' + (call.video ? 'video' : 'voice') + ' call.' : 'Call ended.', call.phase === 'incoming' ? 'Missed ' + (call.video ? 'video' : 'voice') + ' call' : undefined);
  }
  async flush(call) { for (const c of call.candidates.splice(0)) await call.pc.addIceCandidate(c).catch(() => {}); }

  connection(call) {
    const pc = call.pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    for (const track of call.local.getTracks()) pc.addTrack(track, call.local);
    pc.onicecandidate = e => { if (e.candidate && this.call === call) this.send(call.peer, { type: 'candidate', id: call.id, candidate: e.candidate }).catch(() => {}); };
    pc.ontrack = e => {
      if (this.call !== call) return;
      const stream = e.streams[0] || new MediaStream([e.track]); call.remote = stream;
      const el = this.$('remoteVideo'); if (el.srcObject !== stream) { el.srcObject = stream; el.play().catch(() => {}); }
      if (e.track.kind === 'video') { const update = () => { call.remoteVideo = !e.track.muted && e.track.readyState === 'live'; this.show(); }; e.track.onmute = update; e.track.onunmute = update; e.track.onended = update; update(); }
    };
    pc.onconnectionstatechange = () => {
      if (this.call !== call) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(call.lost); call.reconnecting = false;
        if (call.phase !== 'active') { call.phase = 'active'; call.startedAt = Date.now(); call.clock = setInterval(() => this.show(), 1000); }
        this.show();
      } else if (state === 'disconnected') {
        call.reconnecting = true; this.show(); clearTimeout(call.lost);
        call.lost = setTimeout(() => { if (this.call === call && pc.connectionState !== 'connected') { this.send(call.peer, { type: 'end', id: call.id }).catch(() => {}); this.finish('The call was disconnected.'); } }, 12000);
      } else if (state === 'failed') {
        this.send(call.peer, { type: 'end', id: call.id }).catch(() => {});
        this.finish(call.phase === 'active' ? 'The call was disconnected.' : 'Could not connect the call. Your network may block direct connections.');
      }
    };
    // Give up if the connection never comes up.
    call.timer = setTimeout(() => { if (this.call === call && call.phase === 'connecting') { this.send(call.peer, { type: 'end', id: call.id }).catch(() => {}); this.finish('Could not connect the call. Your network may block direct connections.'); } }, 30000);
    return pc;
  }

  async accept() {
    const call = this.call; if (!call || call.phase !== 'incoming') return;
    clearTimeout(call.timer); this.tone(null); try { navigator.vibrate?.(0); } catch {}
    call.phase = 'connecting'; this.show();
    try { call.local = await this.media(call.video); }
    catch (e) { if (this.call === call) { this.send(call.peer, { type: 'decline', id: call.id }).catch(() => {}); this.finish(e.message); } return; }
    if (this.call !== call) { call.local.getTracks().forEach(t => t.stop()); return; }
    this.show(); this.connection(call);
    await this.send(call.peer, { type: 'accept', id: call.id });
  }
  hangup() {
    const call = this.call; if (!call) return;
    this.send(call.peer, { type: call.phase === 'incoming' ? 'decline' : 'end', id: call.id }).catch(() => {});
    this.finish(null, call.phase === 'outgoing' ? 'Call cancelled' : call.phase === 'incoming' ? 'Call declined' : undefined);
  }
  fail(e) { if (this.call) { this.send(this.call.peer, { type: 'end', id: this.call.id }).catch(() => {}); this.finish(e?.message || 'The call failed.'); } }
  // Ends the call locally. `note` is added to the conversation; by default the duration.
  finish(message, note) {
    const call = this.call; if (!call) return; this.call = null;
    clearTimeout(call.timer); clearTimeout(call.lost); clearInterval(call.clock); this.tone(null); try { navigator.vibrate?.(0); } catch {}
    call.local?.getTracks().forEach(t => t.stop()); try { call.pc?.close(); } catch {}
    this.$('remoteVideo').srcObject = null; this.$('localVideo').srcObject = null;
    const kind = call.video ? 'Video call' : 'Voice call';
    if (note === undefined && call.startedAt) note = kind + ' · ' + TrinumCalls.duration(Date.now() - call.startedAt);
    if (note) this.log(call.peer, note, call.role === 'caller');
    this.show(); if (message) this.toast(message);
  }
  end() { if (this.call) this.hangup(); }

  toggle(kind) {
    const call = this.call; if (!call?.local) return;
    const tracks = kind === 'audio' ? call.local.getAudioTracks() : call.local.getVideoTracks(); if (!tracks.length) return;
    const on = !tracks[0].enabled; tracks.forEach(t => { t.enabled = on; });
    if (kind === 'audio') call.muted = !on; else call.cameraOff = !on;
    this.show();
  }
  async flip() {
    const call = this.call, old = call?.local?.getVideoTracks()[0]; if (!old) return;
    const facing = call.facing === 'user' ? 'environment' : 'user';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const track = stream.getVideoTracks()[0]; if (this.call !== call) { track.stop(); return; }
    track.enabled = !call.cameraOff;
    await call.pc?.getSenders().find(s => s.track === old)?.replaceTrack(track);
    call.local.removeTrack(old); old.stop(); call.local.addTrack(track); call.facing = facing; this.show();
  }

  static duration(ms) { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, '0'); return h ? h + ':' + String(m).padStart(2, '0') + ':' + r : m + ':' + r; }

  // Simple generated tones; no audio files needed.
  tone(kind) {
    clearInterval(this.toneTimer); this.toneTimer = null;
    if (!kind) return;
    try {
      const ctx = this.audio ||= new (window.AudioContext || window.webkitAudioContext)(); ctx.resume?.().catch(() => {});
      const beep = () => {
        const notes = kind === 'ring' ? [[880, 0], [660, 0.18], [880, 0.36], [660, 0.54]] : [[440, 0], [480, 0]];
        for (const [freq, at] of notes) {
          const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at, len = kind === 'ring' ? 0.16 : 1.2;
          o.frequency.value = freq; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(kind === 'ring' ? 0.12 : 0.05, t + 0.02); g.gain.setValueAtTime(kind === 'ring' ? 0.12 : 0.05, t + len - 0.04); g.gain.linearRampToValueAtTime(0, t + len);
          o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + len);
        }
      };
      beep(); this.toneTimer = setInterval(beep, kind === 'ring' ? 2000 : 3500);
    } catch {}
  }

  show() {
    const $ = this.$, call = this.call, view = $('callView');
    view.hidden = !call; document.body.classList.toggle('in-call', !!call); this.onChange();
    if (!call) { view.className = 'call-view'; return; }
    const friend = this.friend(call.peer) || { name: 'Friend' };
    $('callName').textContent = friend.name;
    const avatar = $('callAvatar'); avatar.replaceChildren();
    if (friend.avatar) { const img = document.createElement('img'); img.src = friend.avatar; img.alt = ''; avatar.append(img); } else avatar.textContent = (friend.name || '?').trim().slice(0, 1).toUpperCase();
    const local = $('localVideo'), hasLocalVideo = !!call.local?.getVideoTracks().length;
    if (hasLocalVideo && local.srcObject !== call.local) { local.srcObject = call.local; local.play().catch(() => {}); }
    $('callStatus').textContent = call.reconnecting ? 'Reconnecting…' : {
      outgoing: call.local ? 'Calling…' : 'Starting…', incoming: 'Incoming ' + (call.video ? 'video' : 'voice') + ' call',
      connecting: 'Connecting…', active: TrinumCalls.duration(Date.now() - (call.startedAt || Date.now()))
    }[call.phase];
    view.className = 'call-view phase-' + call.phase + (call.video ? ' video' : ' voice') + (call.remoteVideo && call.phase === 'active' ? ' remote-on' : '') + (hasLocalVideo && !call.cameraOff ? ' local-on' : '') + (call.facing === 'user' ? ' mirror' : '');
    $('callIncoming').hidden = call.phase !== 'incoming'; $('callControls').hidden = call.phase === 'incoming';
    $('callAccept').setAttribute('aria-label', 'Accept ' + (call.video ? 'video' : 'voice') + ' call');
    $('callMute').classList.toggle('off', !!call.muted); $('callMute').setAttribute('aria-pressed', String(!!call.muted)); $('callMute').title = call.muted ? 'Unmute' : 'Mute';
    $('callCamera').hidden = !hasLocalVideo; $('callCamera').classList.toggle('off', !!call.cameraOff); $('callCamera').title = call.cameraOff ? 'Turn camera on' : 'Turn camera off';
    $('callFlip').hidden = !hasLocalVideo || !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  }
}
if (typeof module !== 'undefined') module.exports = { TrinumCalls };

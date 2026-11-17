'use strict';
// Audio travels only through the existing encrypted data channel, never the API.
window.TrinumVoice = class TrinumVoice {
  constructor({ channel, received, notice }) { this.channel = channel; this.received = received; this.notice = notice; this.pending = new Map(); this.recording = null; this.draft = null; this.generation = 0; }
  static maxBytes = 1024 * 1024;
  static validMime(mime) { return typeof mime === 'string' && /^audio\/(webm|ogg|mp4)(;codecs=[a-zA-Z0-9., -]+)?$/.test(mime); }
  async start(peer, tick, stopped) {
    this.clearDraft(); const generation = ++this.generation;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error('Voice recording requires HTTPS or localhost and a supported browser.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== this.generation || this.channel(peer)?.readyState !== 'open') { stream.getTracks().forEach(t => t.stop()); throw Error('Recording cancelled or connection closed.'); }
    try {
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(x => MediaRecorder.isTypeSupported(x));
      if (!mime) throw Error('No supported audio recorder was found in this browser.');
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
      const r = { peer, recorder, stream, chunks: [], size: 0, start: Date.now(), cancelled: false }; this.recording = r;
      recorder.ondataavailable = e => { if (e.data.size) { r.size += e.data.size; r.chunks.push(e.data); if (r.size > TrinumVoice.maxBytes) { r.cancelled = true; this.stop(); this.notice('Recording is too large. Try a shorter message.'); } } };
      recorder.onerror = () => { r.cancelled = true; this.stop(); this.notice('Recording failed. Please try again.'); };
      recorder.onstop = () => {
        clearInterval(r.timer); stream.getTracks().forEach(t => t.stop()); if (this.recording === r) this.recording = null;
        const duration = Math.min(60, (Date.now() - r.start) / 1000), blob = new Blob(r.chunks, { type: recorder.mimeType }); r.chunks = [];
        if (!r.cancelled && generation === this.generation && blob.size && blob.size <= TrinumVoice.maxBytes) this.draft = { peer, blob, duration, url: URL.createObjectURL(blob) };
        stopped();
      };
      recorder.start(250);
      r.timer = setInterval(() => { const seconds = Math.floor((Date.now() - r.start) / 1000); tick(seconds); if (seconds >= 60) this.stop(); }, 200); tick(0);
    } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
  }
  stop() { const r = this.recording; if (r && r.recorder.state !== 'inactive') r.recorder.stop(); }
  clearDraft() { if (this.draft) URL.revokeObjectURL(this.draft.url); this.draft = null; }
  cancel() { this.generation++; if (this.recording) { this.recording.cancelled = true; this.stop(); } this.clearDraft(); }
  async send(peer) {
    const draft = this.draft, channel = this.channel(peer); if (!draft || draft.peer !== peer || channel?.readyState !== 'open') throw Error('Reconnect to send your voice message.');
    const id = crypto.randomUUID(), bytes = new Uint8Array(await draft.blob.arrayBuffer());
    const send = async data => {
      const start = Date.now(); while (channel.bufferedAmount > 256 * 1024) { if (Date.now() - start > 10000 || channel.readyState !== 'open') throw Error('Voice transfer interrupted. Try again.'); await new Promise(resolve => setTimeout(resolve, 30)); }
      if (this.draft !== draft || channel.readyState !== 'open') throw Error('Voice transfer cancelled.'); channel.send(JSON.stringify(data));
    };
    try {
      await send({ type: 'voice-start', id, mime: draft.blob.type, size: bytes.length, duration: draft.duration });
      for (let i = 0; i < bytes.length; i += 12000) await send({ type: 'voice-chunk', id, data: btoa(String.fromCharCode(...bytes.subarray(i, i + 12000))) });
      await send({ type: 'voice-end', id });
    } catch (e) { if (channel.readyState === 'open') try { channel.send(JSON.stringify({ type: 'voice-cancel', id })); } catch {} throw e; }
    const message = { text: 'Voice message', voice: { url: URL.createObjectURL(draft.blob), duration: draft.duration, size: draft.blob.size } };
    this.clearDraft(); return message;
  }
  drop(peer) { const r = this.pending.get(peer); if (r) clearTimeout(r.timer); this.pending.delete(peer); }
  receive(peer, message) {
    if (typeof message.type !== 'string' || !message.type.startsWith('voice-')) return false;
    if (message.type === 'voice-start') {
      if (this.pending.has(peer) || this.pending.size >= 4 || typeof message.id !== 'string' || message.id.length > 64 || !TrinumVoice.validMime(message.mime) || !Number.isInteger(message.size) || message.size <= 0 || message.size > TrinumVoice.maxBytes || !Number.isFinite(message.duration) || message.duration <= 0 || message.duration > 61) return true;
      const r = { ...message, chunks: [], bytes: 0 }; r.timer = setTimeout(() => this.drop(peer), 30000); this.pending.set(peer, r); return true;
    }
    const r = this.pending.get(peer); if (!r || r.id !== message.id) return true;
    if (message.type === 'voice-cancel') { this.drop(peer); return true; }
    if (message.type === 'voice-chunk') {
      if (typeof message.data !== 'string' || message.data.length > 16000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) { this.drop(peer); return true; }
      try { const data = Uint8Array.from(atob(message.data), c => c.charCodeAt(0)); r.bytes += data.length; if (r.bytes > r.size || r.chunks.length > 90) this.drop(peer); else r.chunks.push(data); } catch { this.drop(peer); } return true;
    }
    if (message.type === 'voice-end') { this.drop(peer); if (r.bytes === r.size) { const blob = new Blob(r.chunks, { type: r.mime }); this.received(peer, { text: 'Voice message', voice: { url: URL.createObjectURL(blob), duration: r.duration, size: r.size } }); } }
    return true;
  }
  close() { this.cancel(); for (const peer of this.pending.keys()) this.drop(peer); }
};

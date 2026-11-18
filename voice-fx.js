'use strict';
// Voice changer. This one file is loaded twice: as a page script (TrinumVoiceFx) and as an
// AudioWorklet module (the pitch shifters), so it stays within script-src 'self'.

// Natural shifter (used for Female and Child): pitch-synchronous overlap-add. It finds the
// pitch period of the voice, cuts the sound into one grain per vocal-cord pulse and lays the
// grains closer together, so the pitch rises while every grain keeps its own sound. Nothing is
// taken apart into frequencies, so there is no metallic echo. Squeezing each grain slightly
// moves the formants up a little, which makes the voice sound like a smaller speaker.
class TrinumNaturalShifter {
  constructor(rate) {
    this.rate = rate; this.size = 1 << 15; this.mask = this.size - 1;
    this.input = new Float32Array(this.size); this.output = new Float32Array(this.size); this.weight = new Float32Array(this.size);
    this.minT = Math.round(rate / 450); this.maxT = Math.round(rate / 80);
    this.W = Math.round(this.maxT * 2.5); this.hop = 256; this.unvoiced = Math.round(rate * 0.01);
    this.delay = Math.ceil(this.W / 2 + 3 * this.maxT + this.hop);
    this.dec = Math.max(1, Math.round(rate / 12000)); this.dbuf = new Float32Array(8192); this.dn = 0; this.dsum = 0; this.dcount = 0;
    this.est = new Float32Array(1024); this.yin = new Float32Array(Math.ceil(this.maxT / this.dec) + 2);
    this.marks = new Float64Array(512); this.periods = new Float32Array(512); this.voiced = new Uint8Array(512); this.markCount = 0; this.markRead = 0;
    this.n = 0; this.nextMark = 0; this.nextSynth = 0;
  }
  // YIN pitch detection on a decimated copy of the last W samples; 0 means unvoiced or silent.
  estimate() {
    const dec = this.dec, buf = this.dbuf, m = buf.length - 1, Wd = Math.floor(this.W / dec), maxL = Math.floor(this.maxT / dec), minL = Math.max(2, Math.floor(this.minT / dec)), start = this.dn - Wd, len = Wd - maxL;
    let energy = 0; for (let j = 0; j < Wd; j++) { const v = buf[(start + j) & m]; energy += v * v; }
    if (energy / Wd < 1e-6) return 0;
    const d = this.yin; let running = 0; d[0] = 1;
    for (let tau = 1; tau <= maxL; tau++) {
      let sum = 0; for (let j = 0; j < len; j++) { const diff = buf[(start + j) & m] - buf[(start + j + tau) & m]; sum += diff * diff; }
      running += sum; d[tau] = running ? sum * tau / running : 1;
    }
    let tau = -1;
    for (let t = minL; t <= maxL; t++) if (d[t] < 0.2) { while (t + 1 <= maxL && d[t + 1] < d[t]) t++; tau = t; break; }
    if (tau < 0) return 0;
    let shift = 0; if (tau > 1 && tau < maxL) { const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c; if (den > 0) shift = 0.5 * (a - c) / den; }
    return (tau + shift) * dec;
  }
  periodAt(t) { const k = Math.round((t + this.W / 2) / this.hop); return k * this.hop <= this.n ? this.est[k & 1023] : 0; }
  read(pos) { const i = Math.floor(pos), f = pos - i; return this.input[i & this.mask] * (1 - f) + this.input[(i + 1) & this.mask] * f; }
  next(x, pitch, formant) {
    const mask = this.mask, out = (this.n - this.delay) & mask;
    const y = this.n >= this.delay ? this.output[out] / Math.max(this.weight[out], 0.5) : 0;
    this.output[out] = 0; this.weight[out] = 0;
    this.input[this.n & mask] = x; this.n++;
    this.dsum += x; if (++this.dcount === this.dec) { this.dbuf[this.dn++ & (this.dbuf.length - 1)] = this.dsum / this.dec; this.dsum = 0; this.dcount = 0; }
    if (this.n % this.hop === 0) this.est[(this.n / this.hop) & 1023] = this.n > this.W ? this.estimate() : 0;
    // Analysis marks: one per pitch period (or every 10 ms when unvoiced), once their pitch is known.
    while (this.nextMark + this.W / 2 + this.hop <= this.n && this.nextMark + this.maxT <= this.n) {
      const p = this.periodAt(this.nextMark), i = this.markCount++ & 511;
      this.marks[i] = this.nextMark; this.periods[i] = p || this.unvoiced; this.voiced[i] = p ? 1 : 0; this.nextMark += p || this.unvoiced;
    }
    // Synthesis marks: placed every period / pitch, each takes the nearest analysis grain.
    while (this.markCount - this.markRead >= 2 && this.nextSynth <= this.marks[(this.markCount - 1) & 511]) {
      while (this.markCount - this.markRead >= 2 && this.marks[(this.markRead + 1) & 511] <= this.nextSynth) this.markRead++;
      let j = this.markRead & 511; const k = (this.markRead + 1) & 511;
      if (this.markCount - this.markRead >= 2 && this.marks[k] - this.nextSynth < this.nextSynth - this.marks[j]) j = k;
      const a = this.marks[j], H = this.periods[j], voiced = this.voiced[j], f = formant, Ho = Math.floor(H / f), s = Math.round(this.nextSynth), oldest = this.n - this.delay;
      for (let i = -Ho; i <= Ho; i++) {
        if (s + i < oldest) continue;
        const w = 0.5 + 0.5 * Math.cos(Math.PI * i * f / H), o = (s + i) & mask;
        this.output[o] += w * this.read(a + i * f); this.weight[o] += w;
      }
      this.nextSynth += voiced ? H / pitch : H;
    }
    return y;
  }
}

if (typeof module === 'object' && module.exports) module.exports = { TrinumNaturalShifter };

if (typeof registerProcessor === 'function') {
  registerProcessor('trinum-pitch', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2.5, automationRate: 'k-rate' },
        { name: 'formant', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' }
      ];
    }
    constructor() { super(); this.natural = new TrinumNaturalShifter(sampleRate); }
    process(inputs, outputs, parameters) {
      const output = outputs[0]; if (!output.length) return true;
      const source = inputs[0][0], out = output[0], ratio = parameters.ratio[0], formant = parameters.formant[0];
      // formant 0 = unchanged voice. The shifter always runs, so switching voices mid-call is seamless.
      for (let n = 0; n < out.length; n++) {
        const x = source ? source[n] : 0;
        const y = this.natural.next(x, ratio, formant || 1); out[n] = formant ? y : x;
      }
      for (let c = 1; c < output.length; c++) output[c].set(out);
      return true;
    }
  });
} else if (typeof window === 'object') {
  window.TrinumVoiceFx = new class TrinumVoiceFx {
    constructor() {
      this.presets = {
        normal: { label: 'Normal', ratio: 1, low: 0, high: 0, cut: 20 },
        deep: { label: 'Deep', ratio: 0.88, formant: 0.95, low: 1, high: 3, cut: 70 },
        female: { label: 'Female', ratio: 1.5, formant: 1.15, low: -1, high: 1, cut: 100 },
        child: { label: 'Child', ratio: 1.8, formant: 1.28, low: -2, high: 2, cut: 160 }
      };
      this.chains = new Set();
      try { this.current = localStorage.getItem('trinum-voice'); } catch {}
      if (!this.presets[this.current]) this.current = 'normal';
    }
    get supported() { return !!(window.AudioContext && window.AudioWorkletNode && window.MediaStream); }
    get label() { return this.presets[this.current].label; }
    set(name) {
      if (!this.presets[name]) return;
      this.current = name; try { localStorage.setItem('trinum-voice', name); } catch {}
      for (const chain of this.chains) this.apply(chain);
      for (const fn of this.listeners || []) fn(name);
    }
    next() { const names = Object.keys(this.presets); this.set(names[(names.indexOf(this.current) + 1) % names.length]); return this.current; }
    onChange(fn) { (this.listeners ||= []).push(fn); }
    apply(chain) {
      const p = this.presets[this.current];
      chain.pitch.parameters.get('ratio').value = p.ratio; chain.pitch.parameters.get('formant').value = p.formant || 0;
      chain.low.gain.value = p.low; chain.high.gain.value = p.high; chain.cut.frequency.value = p.cut;
    }
    // Returns a stream whose audio goes through the voice changer (video tracks pass through
    // unchanged). Stopping the returned audio track also releases the microphone.
    async process(stream) {
      const mic = stream.getAudioTracks()[0];
      if (!mic || !this.supported) return stream;
      let ctx;
      try {
        ctx = new AudioContext({ latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule('voice-fx.js');
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        const source = ctx.createMediaStreamSource(new MediaStream([mic])), pitch = new AudioWorkletNode(ctx, 'trinum-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const cut = ctx.createBiquadFilter(); cut.type = 'highpass'; cut.Q.value = 0.7;
        const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220;
        const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3000;
        const out = ctx.createMediaStreamDestination(); out.channelCount = 1;
        source.connect(pitch); pitch.connect(cut); cut.connect(low); low.connect(high); high.connect(out);
        const chain = { ctx, pitch, cut, low, high }; this.apply(chain); this.chains.add(chain);
        const track = out.stream.getAudioTracks()[0], stop = track.stop.bind(track);
        track.stop = () => { stop(); mic.stop(); this.chains.delete(chain); ctx.close().catch(() => {}); };
        mic.addEventListener('ended', () => track.stop());
        return new MediaStream([track, ...stream.getVideoTracks()]);
      } catch (e) {
        try { ctx?.close(); } catch {}
        console.warn('Voice changer unavailable', e); return stream;
      }
    }
  }();
}

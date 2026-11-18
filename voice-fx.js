'use strict';
// Voice changer. This one file is loaded twice: as a page script (TrinumVoiceFx) and as an
// AudioWorklet module (the pitch shifters), so it stays within script-src 'self'.

// Time-domain shifter (used for Deep): two read heads sweep through a short delay line and
// cross-fade, so the voice plays slower (deeper) without changing its timing.
class TrinumTimeShifter {
  constructor(rate) { this.size = 16384; this.buffer = new Float32Array(this.size); this.write = 0; this.phase = 0; this.window = Math.round(rate * 0.045); }
  read(delay) { const pos = this.write - delay, i = Math.floor(pos), f = pos - i, m = this.size - 1; return this.buffer[i & m] * (1 - f) + this.buffer[(i + 1) & m] * f; }
  next(x, ratio) {
    this.buffer[this.write & (this.size - 1)] = x; let y = x;
    if (ratio !== 1) {
      const w = this.window, p1 = this.phase, p2 = (p1 + 0.5) % 1, g1 = Math.sin(Math.PI * p1) ** 2;
      y = this.read(p1 * w + 2) * g1 + this.read(p2 * w + 2) * (1 - g1);
      this.phase = ((this.phase + (1 - ratio) / w) % 1 + 1) % 1;
    }
    if (++this.write >= 1 << 30) this.write -= 1 << 29;
    return y;
  }
}

// Formant-preserving shifter (used for Female and Child): a phase vocoder raises the pitch
// while the spectral envelope (the shape of the mouth and throat) is kept and only moved up
// a little, so the voice sounds like a different person instead of a sped-up recording.
class TrinumFormantShifter {
  constructor(rate) {
    const N = this.N = rate >= 32000 ? 2048 : 1024, osamp = this.osamp = 4;
    this.step = N / osamp; this.rate = rate; this.latency = N - this.step; this.rover = this.latency; this.half = N / 2;
    this.inFifo = new Float32Array(N); this.outFifo = new Float32Array(N); this.accum = new Float32Array(2 * N);
    this.re = new Float64Array(N); this.im = new Float64Array(N); this.cre = new Float64Array(N); this.cim = new Float64Array(N);
    const bins = N / 2 + 1;
    this.lastPhase = new Float64Array(bins); this.sumPhase = new Float64Array(bins); this.anaMag = new Float64Array(bins); this.anaFreq = new Float64Array(bins);
    this.synMag = new Float64Array(bins); this.synFreq = new Float64Array(bins); this.env = new Float64Array(bins);
    this.window = new Float64Array(N); for (let k = 0; k < N; k++) this.window[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N);
    this.lifter = Math.max(8, Math.round(rate * 0.0012));
    const bits = Math.log2(N); this.rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(N / 2); this.sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / N); this.sin[i] = Math.sin(2 * Math.PI * i / N); }
  }
  fft(re, im, inverse) {
    const N = this.N, rev = this.rev, sign = inverse ? 1 : -1;
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >> 1, stride = N / size;
      for (let i = 0; i < N; i += size) for (let j = 0; j < halfSize; j++) {
        const wr = this.cos[j * stride], wi = sign * this.sin[j * stride], a = i + j, b = a + halfSize;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  // Cepstral smoothing of the log spectrum: the formant envelope without the harmonics.
  envelope() {
    const N = this.N, half = this.half, cre = this.cre, cim = this.cim, L = this.lifter;
    for (let k = 0; k <= half; k++) { cre[k] = Math.log(this.anaMag[k] + 1e-9); cim[k] = 0; }
    for (let k = half + 1; k < N; k++) { cre[k] = cre[N - k]; cim[k] = 0; }
    this.fft(cre, cim, true);
    for (let q = 0; q < N; q++) { const d = Math.min(q, N - q), w = d < L ? 1 : d === L ? 0.5 : 0; cre[q] *= w / N; cim[q] = 0; }
    this.fft(cre, cim, false);
    for (let k = 0; k <= half; k++) this.env[k] = Math.exp(cre[k]);
  }
  frame(pitch, formant) {
    const N = this.N, half = this.half, osamp = this.osamp, expct = 2 * Math.PI * this.step / N, binHz = this.rate / N, re = this.re, im = this.im;
    for (let k = 0; k < N; k++) { re[k] = this.inFifo[k] * this.window[k]; im[k] = 0; }
    this.fft(re, im, false);
    for (let k = 0; k <= half; k++) {
      const phase = Math.atan2(im[k], re[k]);
      let d = phase - this.lastPhase[k] - k * expct; this.lastPhase[k] = phase;
      let qpd = Math.trunc(d / Math.PI); qpd += qpd >= 0 ? (qpd & 1) : -((-qpd) & 1); d -= Math.PI * qpd;
      this.anaMag[k] = 2 * Math.hypot(re[k], im[k]); this.anaFreq[k] = (k + osamp * d / (2 * Math.PI)) * binHz;
    }
    this.envelope();
    this.synMag.fill(0); this.synFreq.fill(0);
    for (let k = 0; k <= half; k++) {
      const index = Math.round(k * pitch);
      if (index <= half) { this.synMag[index] += this.anaMag[k] / (this.env[k] + 1e-9); this.synFreq[index] = this.anaFreq[k] * pitch; }
    }
    for (let k = 0; k <= half; k++) {
      const src = k / formant, i = Math.floor(src), f = src - i;
      const e = i >= half ? this.env[half] * 1e-3 : this.env[i] * (1 - f) + this.env[i + 1] * f, mag = this.synMag[k] * e;
      this.sumPhase[k] = (this.sumPhase[k] + (this.synFreq[k] / binHz - k) * 2 * Math.PI / osamp + k * expct) % (2 * Math.PI);
      re[k] = mag * Math.cos(this.sumPhase[k]); im[k] = mag * Math.sin(this.sumPhase[k]);
    }
    for (let k = half + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
    this.fft(re, im, true);
    for (let k = 0; k < N; k++) this.accum[k] += 2 * this.window[k] * re[k] / (half * osamp);
    for (let k = 0; k < this.step; k++) this.outFifo[k] = this.accum[k];
    this.accum.copyWithin(0, this.step, this.step + N); this.accum.fill(0, N);
    this.inFifo.copyWithin(0, this.step, N);
  }
  next(x, pitch, formant) {
    this.inFifo[this.rover] = x; const y = this.outFifo[this.rover - this.latency];
    if (++this.rover >= this.N) { this.rover = this.latency; this.frame(pitch, formant); }
    return y;
  }
}

if (typeof module === 'object' && module.exports) module.exports = { TrinumTimeShifter, TrinumFormantShifter };

if (typeof registerProcessor === 'function') {
  registerProcessor('trinum-pitch', class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2.5, automationRate: 'k-rate' },
        { name: 'formant', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' }
      ];
    }
    constructor() { super(); this.time = new TrinumTimeShifter(sampleRate); this.vocoder = new TrinumFormantShifter(sampleRate); }
    process(inputs, outputs, parameters) {
      const output = outputs[0]; if (!output.length) return true;
      const source = inputs[0][0], out = output[0], ratio = parameters.ratio[0], formant = parameters.formant[0];
      // formant 0 = time-domain shifter (Deep); otherwise the formant-preserving vocoder.
      for (let n = 0; n < out.length; n++) {
        const x = source ? source[n] : 0;
        out[n] = formant ? this.vocoder.next(x, ratio, formant) : this.time.next(x, ratio);
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
        deep: { label: 'Deep', ratio: 0.88, low: 1, high: 3, cut: 70 },
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

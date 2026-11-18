'use strict';
// Voice changer. This one file is loaded twice: as a page script (TrinumVoiceFx) and as an
// AudioWorklet module (the pitch shifter), so it stays within script-src 'self'.
if (typeof registerProcessor === 'function') {
  // Real-time pitch shifter: two read heads sweep through a short delay line and cross-fade,
  // so the voice plays back faster (higher) or slower (deeper) without changing its timing.
  registerProcessor('trinum-pitch', class extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }]; }
    constructor() { super(); this.size = 16384; this.buffer = new Float32Array(this.size); this.write = 0; this.phase = 0; this.window = Math.round(sampleRate * 0.045); }
    read(delay) {
      const pos = this.write - delay, i = Math.floor(pos), f = pos - i, m = this.size - 1;
      return this.buffer[i & m] * (1 - f) + this.buffer[(i + 1) & m] * f;
    }
    process(inputs, outputs, parameters) {
      const input = inputs[0], output = outputs[0], ratio = parameters.ratio[0], w = this.window, step = (1 - ratio) / w;
      if (!output.length) return true;
      const source = input[0], out = output[0];
      for (let n = 0; n < out.length; n++) {
        this.buffer[this.write & (this.size - 1)] = source ? source[n] : 0;
        let sample;
        if (ratio === 1) sample = source ? source[n] : 0;
        else {
          const p1 = this.phase, p2 = (this.phase + 0.5) % 1, g1 = Math.sin(Math.PI * p1) ** 2, g2 = 1 - g1;
          sample = this.read(p1 * w + 2) * g1 + this.read(p2 * w + 2) * g2;
          this.phase = ((this.phase + step) % 1 + 1) % 1;
        }
        out[n] = sample; this.write++;
        if (this.write >= 1 << 30) this.write -= 1 << 29;
      }
      for (let c = 1; c < output.length; c++) output[c].set(out);
      return true;
    }
  });
} else {
  window.TrinumVoiceFx = new class TrinumVoiceFx {
    constructor() {
      this.presets = {
        normal: { label: 'Normal', ratio: 1, low: 0, high: 0, cut: 20 },
        deep: { label: 'Deep', ratio: 0.72, low: 5, high: -3, cut: 20 },
        female: { label: 'Female', ratio: 1.38, low: -3, high: 2, cut: 140 },
        child: { label: 'Child', ratio: 1.72, low: -6, high: 4, cut: 230 }
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
      chain.pitch.parameters.get('ratio').value = p.ratio;
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

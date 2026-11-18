'use strict';
// Face privacy for video calls: Normal, Mask or Blur. With Mask or Blur the camera never goes
// to the call directly: every frame is drawn on a canvas, the face is found with MediaPipe's
// face detector (served by Trinum itself) and covered before the frame is sent. The filter
// fails closed: until the detector is ready, or whenever no face is found, the whole picture
// is pixelated, so the face is never shown by mistake.
window.TrinumVideoFx = new class TrinumVideoFx {
  constructor() {
    this.modes = { normal: 'Normal', mask: 'Mask', blur: 'Blur face' };
    try { this.current = localStorage.getItem('trinum-face'); } catch {}
    if (!this.modes[this.current]) this.current = 'normal';
    this.listeners = []; this.detector = null; this.loading = null; this.mask = null;
  }
  get label() { return this.modes[this.current]; }
  get supported() { return !!(HTMLCanvasElement.prototype.captureStream && window.MediaStream); }
  set(mode) {
    if (!this.modes[mode]) return;
    this.current = mode; try { localStorage.setItem('trinum-face', mode); } catch {}
    if (mode !== 'normal') this.load();
    for (const fn of this.listeners) fn(mode);
  }
  next() { const names = Object.keys(this.modes); this.set(names[(names.indexOf(this.current) + 1) % names.length]); return this.current; }
  onChange(fn) { this.listeners.push(fn); }

  // Loads the detector once (about 10 MB the first time, then cached by the browser).
  load() {
    return this.loading ||= (async () => {
      const vision = await import('/vendor/mediapipe/vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe');
      const options = delegate => ({ baseOptions: { modelAssetPath: '/vendor/mediapipe/blaze_face_short_range.tflite', delegate }, runningMode: 'VIDEO', minDetectionConfidence: 0.3, minSuppressionThreshold: 0.3 });
      try { this.detector = await vision.FaceDetector.createFromOptions(files, options('GPU')); }
      catch { this.detector = await vision.FaceDetector.createFromOptions(files, options('CPU')); }
      return this.detector;
    })().catch(e => { console.warn('Face detector unavailable', e); this.loading = null; return null; });
  }

  // An original mask: smooth, opaque, with dark eye shapes (nothing behind it shows through).
  maskImage() {
    if (this.mask) return this.mask;
    const c = document.createElement('canvas'); c.width = 400; c.height = 500; const g = c.getContext('2d');
    const face = new Path2D(); face.ellipse(200, 250, 190, 240, 0, 0, Math.PI * 2);
    const shade = g.createLinearGradient(0, 0, 400, 500); shade.addColorStop(0, '#fbfaf5'); shade.addColorStop(1, '#d9d6cc');
    g.fillStyle = shade; g.fill(face); g.lineWidth = 6; g.strokeStyle = '#1f2a29'; g.stroke(face);
    g.fillStyle = '#121a19';
    for (const side of [-1, 1]) { g.beginPath(); g.ellipse(200 + side * 78, 215, 46, 20, side * -0.18, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = '#2a3534'; g.lineWidth = 7; g.lineCap = 'round';
    for (const side of [-1, 1]) { g.beginPath(); g.moveTo(200 + side * 30, 168); g.quadraticCurveTo(200 + side * 80, 150, 200 + side * 128, 175); g.stroke(); }
    g.beginPath(); g.moveTo(200, 240); g.quadraticCurveTo(188, 300, 200, 318); g.stroke();
    g.beginPath(); g.moveTo(140, 370); g.quadraticCurveTo(200, 405, 260, 370); g.stroke();
    for (const side of [-1, 1]) { g.fillStyle = '#e6a9a066'; g.beginPath(); g.ellipse(200 + side * 112, 315, 28, 16, 0, 0, Math.PI * 2); g.fill(); }
    return this.mask = c;
  }

  // Returns { track, setSource(rawTrack), destroy() }. The returned track carries only
  // processed frames; stopping it never stops the camera track (the call owns that).
  create(raw) {
    const fx = this, video = document.createElement('video'), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const small = document.createElement('canvas'), sctx = small.getContext('2d');
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
    canvas.width = 640; canvas.height = 480; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480);
    const state = { boxes: [], seen: 0, stamp: 0, stopped: false, faces: 0, covered: 'all' };
    const setSource = track => { video.srcObject = new MediaStream([track]); video.play().catch(() => {}); state.boxes = []; state.seen = 0; };
    setSource(raw);
    if (this.current !== 'normal') this.load();
    const output = canvas.captureStream(30), track = output.getVideoTracks()[0];

    // Pixelates a region down to a few blocks; nothing finer than a block can survive.
    const pixelate = (x, y, w, h, blocks) => {
      const bw = Math.max(1, Math.round(blocks)), bh = Math.max(1, Math.round(blocks * h / w));
      small.width = bw; small.height = bh; sctx.imageSmoothingEnabled = true;
      sctx.drawImage(canvas, x, y, w, h, 0, 0, bw, bh);
      ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, bw, bh, x, y, w, h);
    };
    const cover = (box, mode) => {
      const { x, y, w, h } = box;
      ctx.save(); ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.clip();
      pixelate(x, y, w, h, 5); ctx.restore();
      if (mode === 'mask') ctx.drawImage(fx.maskImage(), x + w * 0.04, y + h * 0.02, w * 0.92, h * 0.96);
    };
    const coverAll = (w, h, mode) => {
      pixelate(0, 0, w, h, 14);
      ctx.fillStyle = '#050b0b99'; ctx.fillRect(0, 0, w, h);
      if (mode === 'mask') { const s = Math.min(w, h) * 0.55; ctx.drawImage(fx.maskImage(), (w - s * 0.8) / 2, (h - s) / 2, s * 0.8, s); }
    };
    // Face box from the detector, enlarged to include hair, ears, chin and some movement.
    const grow = (b, w, h, extra) => {
      const cx = b.originX + b.width / 2, cy = b.originY + b.height * 0.42, bw = b.width * 1.9 * extra, bh = b.height * 2.3 * extra;
      const x = Math.max(0, cx - bw / 2), y = Math.max(0, cy - bh / 2);
      return { x, y, w: Math.min(w, cx + bw / 2) - x, h: Math.min(h, cy + bh / 2) - y };
    };
    const draw = () => {
      if (state.stopped) return;
      const w = video.videoWidth, h = video.videoHeight, mode = fx.current;
      if (!w || !h) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      if (mode === 'normal') { state.covered = 'none'; return; }
      const now = performance.now(); let found = null;
      if (fx.detector) {
        try {
          state.stamp = Math.max(state.stamp + 1, now);
          const result = fx.detector.detectForVideo(video, state.stamp);
          found = result.detections.map(d => d.boundingBox).filter(b => b && b.width > 4 && b.height > 4);
        } catch (e) { found = null; }
      }
      if (found && found.length) { state.boxes = found; state.seen = now; }
      state.faces = found ? found.length : 0;
      const age = now - state.seen;
      if (state.boxes.length && age < 300) {
        // A face lost for a moment keeps its (wider) cover; after 300 ms the whole frame is hidden.
        for (const b of state.boxes) cover(grow(b, w, h, found && found.length ? 1 : 1.35), mode);
        state.covered = 'face';
      } else { coverAll(w, h, mode); state.covered = 'all'; }
    };
    const timer = setInterval(draw, 33);
    const stopTrack = track.stop.bind(track);
    const destroy = () => { if (state.stopped) return; state.stopped = true; clearInterval(timer); stopTrack(); video.pause(); video.srcObject = null; };
    track.stop = destroy;
    return { track, setSource, destroy, state, canvas };
  }
}();

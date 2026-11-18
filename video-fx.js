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
    this.maskStyle = 'anonymous'; this.anonymous = null; this.anonymousLoading = null;
    this.listeners = []; this.detector = null; this.loading = null; this.mask = null;
  }
  get label() { return this.modes[this.current]; }
  get supported() { return !!(HTMLCanvasElement.prototype.captureStream && window.MediaStream); }
  set(mode) {
    if (!this.modes[mode]) return;
    this.current = mode; try { localStorage.setItem('trinum-face', mode); } catch {}
    if (mode !== 'normal') this.load();
    if (mode === 'mask') this.loadAnonymous();
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

  // The Anonymous mask image (assets/mask-anonymous.webp). The white around the outline is
  // removed and everything inside is made fully opaque, so nothing of the face shows through.
  // Until it has loaded, the painted porcelain mask is used instead.
  loadAnonymous() {
    return this.anonymousLoading ||= new Promise(resolve => {
      const img = new Image(); img.decoding = 'async';
      img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight, c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
        const data = g.getImageData(0, 0, W, H), px = data.data, outside = new Uint8Array(W * H), stack = [];
        // Background = transparent or near-white pixels connected to the image border.
        const bg = i => px[i * 4 + 3] < 40 || (px[i * 4] > 238 && px[i * 4 + 1] > 238 && px[i * 4 + 2] > 238);
        for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x); for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
        while (stack.length) { const i = stack.pop(); if (outside[i] || !bg(i)) continue; outside[i] = 1; const x = i % W; if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1); if (i >= W) stack.push(i - W); if (i < W * (H - 1)) stack.push(i + W); }
        for (let i = 0; i < W * H; i++) {
          if (outside[i]) { px[i * 4 + 3] = 0; continue; }
          const a = px[i * 4 + 3] / 255; // composite any see-through pixel over white, then make it opaque
          for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.round(px[i * 4 + k] * a + 255 * (1 - a));
          px[i * 4 + 3] = 255;
        }
        g.putImageData(data, 0, 0);
        // Light from the upper left: the flat drawing gets the curve of a real mask.
        g.globalCompositeOperation = 'source-atop';
        const shade = g.createRadialGradient(W * 0.38, H * 0.28, W * 0.05, W * 0.5, H * 0.5, W * 0.85);
        shade.addColorStop(0, 'rgba(255,255,255,0)'); shade.addColorStop(0.55, 'rgba(70,64,58,0.12)'); shade.addColorStop(1, 'rgba(30,26,22,0.5)');
        g.fillStyle = shade; g.fillRect(0, 0, W, H);
        const gloss = g.createRadialGradient(W * 0.36, H * 0.13, 0, W * 0.36, H * 0.13, W * 0.22);
        gloss.addColorStop(0, 'rgba(255,255,255,0.55)'); gloss.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gloss; g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
        // Eye line and distance in the image, used to sit the mask on the detected eyes.
        this.anonymous = { img: c, ex: W * 0.5, ey: H * 0.345, dist: W * 0.5, half: 0.42, top: 0.03, bottom: 0.95 }; resolve(this.anonymous);
      };
      img.onerror = () => { this.anonymousLoading = null; resolve(null); };
      img.src = '/assets/mask-anonymous.webp';
    });
  }
  maskArt() {
    if (this.maskStyle === 'anonymous') { if (this.anonymous) return this.anonymous; this.loadAnonymous(); }
    return { img: this.maskImage('porcelain'), ex: 300, ey: 338, dist: 208, half: 0.36, top: 0.04, bottom: 0.95 };
  }

  // Original full-face masks, painted once at 600x800 with light from the upper left:
  // porcelain (ivory with gold leaf), noir (black lacquer with silver filigree) and chrome
  // (a faceless mirror). Every pixel inside the outline is opaque; the eyes are solid black.
  maskImage(style = this.maskStyle) {
    this.masks ||= {}; if (this.masks[style]) return this.masks[style];
    const P = {
      porcelain: { light: '#fffdf7', mid: '#e9e2d4', dark: '#9c917e', shade: '#4a4135', hi: '#ffffff', spec: 0.85, trim: '#b8913c', trim2: '#f1d88e', grain: 0.06, lips: true },
      noir: { light: '#55585f', mid: '#1c1d21', dark: '#060607', shade: '#000000', hi: '#d9dee6', spec: 0.6, trim: '#8e98a3', trim2: '#eef2f6', grain: 0.05, lips: true, filigree: true },
      chrome: { light: '#f7f9fb', mid: '#a7b0b9', dark: '#3a4148', shade: '#0b0e11', hi: '#ffffff', spec: 1, trim: '#5d666f', trim2: '#e2e7eb', grain: 0.025, lips: false, mirror: true }
    }[style] || {};
    const c = document.createElement('canvas'); c.width = 600; c.height = 800; const g = c.getContext('2d');
    const face = new Path2D();
    face.moveTo(300, 26);
    face.bezierCurveTo(452, 26, 548, 150, 546, 318); face.bezierCurveTo(544, 452, 506, 566, 438, 664);
    face.bezierCurveTo(398, 722, 352, 774, 300, 776); face.bezierCurveTo(248, 774, 202, 722, 162, 664);
    face.bezierCurveTo(94, 566, 56, 452, 54, 318); face.bezierCurveTo(52, 150, 148, 26, 300, 26); face.closePath();
    const eye = side => { const p = new Path2D(), x = 300 + side * 104, y = 338; p.moveTo(x - 64 * side, y + 8); p.bezierCurveTo(x - 34 * side, y - 30, x + 30 * side, y - 34, x + 68 * side, y - 6); p.bezierCurveTo(x + 34 * side, y + 22, x - 28 * side, y + 30, x - 64 * side, y + 8); p.closePath(); return p; };
    // Soft shading: the shape itself is drawn far off-canvas and only its blurred shadow lands
    // on the mask. This works in every browser (no canvas filters needed).
    const soft = (shape, color, alpha, blur) => {
      g.save(); g.globalAlpha = alpha; g.shadowColor = color; g.shadowBlur = blur; g.shadowOffsetX = 3000;
      g.translate(-3000, 0); g.fillStyle = color; g.beginPath(); shape(); g.fill(); g.restore();
    };
    const oval = (x, y, rx, ry, rot = 0) => () => g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    const poly = pts => () => { g.moveTo(pts[0][0], pts[0][1]); let i = 1; for (; i + 2 < pts.length; i += 3) g.bezierCurveTo(...pts[i], ...pts[i + 1], ...pts[i + 2]); for (; i < pts.length; i++) g.lineTo(...pts[i]); g.closePath(); };

    g.save(); g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = 46; g.shadowOffsetX = 12; g.shadowOffsetY = 18; g.fillStyle = P.dark; g.fill(face); g.restore();
    g.save(); g.clip(face);
    // Base: a curved surface lit from the upper left.
    const base = g.createRadialGradient(236, 250, 30, 300, 420, 480); base.addColorStop(0, P.light); base.addColorStop(0.5, P.mid); base.addColorStop(1, P.dark); g.fillStyle = base; g.fillRect(0, 0, 600, 800);
    if (P.mirror) {
      // Mirror: horizon reflections bent around the face.
      const m = g.createLinearGradient(0, 0, 0, 800);
      [[0, '#eef3f7'], [0.22, '#c9d2da'], [0.36, '#5a636c'], [0.42, '#f4f8fb'], [0.5, '#3a4148'], [0.68, '#88939d'], [0.85, '#2a3036'], [1, '#6c7680']].forEach(([o, col]) => m.addColorStop(o, col));
      g.globalAlpha = 0.55; g.fillStyle = m; g.fillRect(0, 0, 600, 800); g.globalAlpha = 1;
    }
    // Form: temples and jaw turn away from the light; the right side sits in shadow.
    soft(oval(40, 380, 70, 320), P.shade, 0.55, 90); soft(oval(575, 400, 90, 340), P.shade, 0.8, 100);
    soft(oval(300, 800, 260, 80), P.shade, 0.6, 80);
    soft(oval(300, 150, 190, 90), P.hi, 0.35, 90);                                   // forehead dome
    soft(poly([[160, 272], [220, 236], [380, 236], [440, 272], [380, 262], [220, 262], [160, 272]]), P.hi, 0.5, 26); // brow ridge
    for (const side of [-1, 1]) {
      soft(oval(300 + side * 104, 344, 92, 56, side * 0.12), P.shade, 0.75, 44);      // deep eye socket
      soft(oval(300 + side * 128, 466, 70, 40, side * -0.3), P.hi, side < 0 ? 0.55 : 0.22, 50);  // cheekbone
      soft(oval(300 + side * 140, 548, 70, 60), P.shade, side < 0 ? 0.25 : 0.55, 60);   // hollow under the cheek
      soft(oval(300 + side * 70, 300, 40, 14, side * -0.2), P.shade, 0.35, 18);         // brow crease
    }
    // Nose: a lit ridge narrowing upward, a shadowed right flank and the shadow under the tip.
    soft(poly([[292, 300], [296, 360], [292, 440], [286, 500], [298, 516], [312, 500], [306, 440], [304, 360], [308, 300], [292, 300]]), P.hi, 0.75, 14);
    soft(poly([[312, 330], [330, 400], [348, 470], [344, 520], [330, 528], [318, 470], [310, 400], [312, 330], [312, 330]]), P.shade, 0.6, 22);
    soft(oval(300, 534, 44, 10), P.shade, 0.8, 16); soft(oval(276, 510, 14, 9), P.hi, 0.6, 10);
    soft(oval(300, 572, 22, 10), P.shade, 0.35, 12);                                  // philtrum
    if (P.lips) {
      soft(poly([[250, 600], [272, 586], [292, 584], [300, 590], [308, 584], [328, 586], [350, 600], [320, 604], [280, 604], [250, 600]]), P.hi, 0.45, 10);
      soft(poly([[256, 604], [280, 628], [320, 628], [344, 604], [320, 610], [280, 610], [256, 604]]), P.hi, 0.55, 10);
      g.save(); g.strokeStyle = P.shade; g.globalAlpha = 0.55; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(252, 603); g.bezierCurveTo(276, 608, 290, 600, 300, 604); g.bezierCurveTo(310, 600, 324, 608, 348, 603); g.stroke(); g.restore();
      soft(oval(300, 642, 36, 8), P.shade, 0.45, 12);
    }
    soft(oval(300, 690, 64, 34), P.hi, 0.35, 34);                                     // chin
    // Gloss: one bright highlight on the forehead and small ones on the nose, cheek and chin.
    soft(oval(236, 150, 70, 30, -0.25), P.hi, P.spec, 30); soft(oval(296, 410, 6, 44), P.hi, P.spec * 0.9, 8);
    soft(oval(190, 452, 26, 10, -0.4), P.hi, P.spec * 0.6, 14); soft(oval(282, 684, 18, 7), P.hi, P.spec * 0.5, 10);
    // Fine grain so the surface reads as a real material.
    const n = document.createElement('canvas'); n.width = n.height = 128; const ng = n.getContext('2d'), img = ng.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) { const v = 96 + Math.random() * 64; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    ng.putImageData(img, 0, 0); g.globalAlpha = P.grain; g.globalCompositeOperation = 'overlay'; g.fillStyle = g.createPattern(n, 'repeat'); g.fillRect(0, 0, 600, 800);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    if (P.filigree) {
      g.strokeStyle = P.trim2; g.lineWidth = 2; g.globalAlpha = 0.7; g.lineCap = 'round';
      for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
        const x = 300 + side * 104, y = 338; g.beginPath();
        g.moveTo(x + side * (66 + k * 10), y - 10 - k * 4); g.bezierCurveTo(x + side * (104 + k * 14), y - 64 - k * 18, x + side * (38 - k * 8), y - 112 - k * 20, x + side * (-6 - k * 12), y - 88 - k * 14);
        g.bezierCurveTo(x + side * (-30 - k * 8), y - 76 - k * 8, x + side * (-24 - k * 4), y - 56 - k * 4, x + side * (-6 - k * 3), y - 60 - k * 4); g.stroke();
      }
      g.globalAlpha = 1;
    }
    // Eye openings: a sculpted rim, then solid black so nothing behind can be seen.
    for (const side of [-1, 1]) {
      const p = eye(side);
      soft(() => { const q = eye(side); g.fill(q); }, '#000', 0.8, 22);
      g.save(); g.fillStyle = '#000'; g.fill(p); g.restore();
      g.save(); g.clip(p); const e = g.createLinearGradient(0, 304, 0, 372); e.addColorStop(0, '#1a1b1e'); e.addColorStop(0.35, '#000'); e.addColorStop(1, '#020203'); g.fillStyle = e; g.fillRect(0, 0, 600, 800); g.restore();
      g.save(); g.strokeStyle = P.hi; g.globalAlpha = 0.35; g.lineWidth = 1.5; g.translate(0, 2); g.stroke(p); g.restore();
    }
    g.restore();
    // Rim: a thin metal edge around the whole mask.
    const rim = g.createLinearGradient(0, 0, 600, 800); rim.addColorStop(0, P.trim2); rim.addColorStop(0.45, P.trim); rim.addColorStop(0.7, P.trim2); rim.addColorStop(1, P.trim);
    g.strokeStyle = rim; g.lineWidth = 6; g.stroke(face);
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 1.5; g.stroke(face);
    return this.masks[style] = c;
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
    // Blur face: the enlarged face area is pixelated.
    const cover = box => {
      const { x, y, w, h } = box;
      ctx.save(); ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.clip();
      pixelate(x, y, w, h, 5); ctx.restore();
    };
    // Mask: sits on the detected eyes, tilts with the head, and is scaled so its opaque area
    // reaches past the forehead, the chin and both cheeks of the detected face.
    const placeMask = (fit, grow = 1) => {
      const art = fx.maskArt(), W = art.img.width, H = art.img.height;
      let s = fit.scale ? fit.scale / W : fit.width / W;
      if (!fit.scale && fit.eyes) {
        s = Math.max(fit.eyes / art.dist, fit.half / (art.half * W), fit.up / (art.ey - art.top * H), fit.down / (art.bottom * H - art.ey)) * 1.06;
      }
      s *= grow;
      ctx.save(); ctx.translate(fit.ex, fit.ey); ctx.rotate(fit.roll); ctx.drawImage(art.img, -art.ex * s, -art.ey * s, W * s, H * s); ctx.restore();
    };
    const fitFor = (d, w, h) => {
      const b = d.boundingBox, k = d.keypoints || [];
      let ex = b.originX + b.width / 2, ey = b.originY + b.height * 0.36, roll = 0, eyes = b.width * 0.62;
      if (k.length >= 2) {
        let [a, c] = [k[0], k[1]]; if (a.x > c.x) [a, c] = [c, a];
        const ax = a.x * w, ay = a.y * h, cx2 = c.x * w, cy2 = c.y * h, dist = Math.hypot(cx2 - ax, cy2 - ay);
        ex = (ax + cx2) / 2; ey = (ay + cy2) / 2; roll = Math.max(-0.6, Math.min(0.6, Math.atan2(cy2 - ay, cx2 - ax)));
        eyes = Math.max(eyes, dist * 1.05);
      }
      // How far the mask must reach from the eye line: forehead above, chin below, cheeks aside.
      const tilt = 1 + Math.abs(roll) * 0.6;
      const up = (ey - (b.originY - b.height * 0.3)) * tilt, down = (b.originY + b.height * 1.1 - ey) * tilt, half = (b.width * 0.6 + Math.abs(ex - (b.originX + b.width / 2))) * tilt;
      return { ex, ey, roll, eyes, up, down, half };
    };
    const coverAll = (w, h, mode) => {
      pixelate(0, 0, w, h, 14);
      if (mode === 'mask') placeMask({ ex: w / 2, ey: h * 0.4, roll: 0, width: Math.min(w, h) * 0.5 });
      else { ctx.fillStyle = '#050b0b99'; ctx.fillRect(0, 0, w, h); }
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
          found = result.detections.filter(d => d.boundingBox && d.boundingBox.width > 4 && d.boundingBox.height > 4);
        } catch (e) { found = null; }
      }
      if (found && found.length) {
        // Smooth the mask's position between frames so it moves like a real one.
        const fits = found.map(d => fitFor(d, w, h)), prev = state.fits || [];
        state.fits = fits.map((f, i) => { const p = prev[i]; if (!p || Math.hypot(p.ex - f.ex, p.ey - f.ey) > f.eyes) return f; const m = (a, b) => a + (b - a) * 0.55; return { ex: m(p.ex, f.ex), ey: m(p.ey, f.ey), roll: m(p.roll, f.roll), eyes: Math.max(m(p.eyes, f.eyes), f.eyes * 0.97), up: Math.max(m(p.up, f.up), f.up), down: Math.max(m(p.down, f.down), f.down), half: Math.max(m(p.half, f.half), f.half) }; });
        state.boxes = found.map(d => d.boundingBox); state.seen = now;
      }
      state.faces = found ? found.length : 0;
      const age = now - state.seen;
      if (state.boxes.length && age < 300) {
        // A face lost for a moment keeps its (wider) cover; after 300 ms the whole frame is hidden.
        // A face lost for a moment keeps a slightly larger cover.
        const fresh = found && found.length;
        if (mode === 'mask') for (const f of state.fits || []) placeMask(f, fresh ? 1 : 1.15);
        else for (const b of state.boxes) cover(grow(b, w, h, fresh ? 1 : 1.35));
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

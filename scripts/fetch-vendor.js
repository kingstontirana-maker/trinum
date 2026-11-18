'use strict';
// Downloads the face detector (MediaPipe Tasks Vision + BlazeFace short-range model) into
// vendor/mediapipe so Trinum serves it itself; every file is checked against a pinned SHA-256.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/';
const files = {
  'vision_bundle.mjs': [base + 'vision_bundle.mjs', 'e77f281f9619150d937023c355bae170e9120e3b9e43f1e23a2a7bee07197669'],
  'vision_wasm_internal.js': [base + 'wasm/vision_wasm_internal.js', '9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c'],
  'vision_wasm_internal.wasm': [base + 'wasm/vision_wasm_internal.wasm', 'f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc'],
  'vision_wasm_nosimd_internal.js': [base + 'wasm/vision_wasm_nosimd_internal.js', 'abe9b6fbeaf86fcb53a5edce3926c82ccb0619e18fed4d9d9ce561ee7f55e054'],
  'vision_wasm_nosimd_internal.wasm': [base + 'wasm/vision_wasm_nosimd_internal.wasm', '38b61feab2fd7934e05cbe9f68baa308978a5e3b7f85c1913bb8ae89b8ef8b97'],
  'blaze_face_short_range.tflite': ['https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f']
};
(async () => {
  const dir = path.join(__dirname, '..', 'vendor', 'mediapipe'); fs.mkdirSync(dir, { recursive: true });
  for (const [name, [url, sha]] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (fs.existsSync(target) && sha && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === sha) continue;
    const res = await fetch(url); if (!res.ok) throw Error(name + ': HTTP ' + res.status);
    const data = Buffer.from(await res.arrayBuffer()), hash = crypto.createHash('sha256').update(data).digest('hex');
    if (sha && hash !== sha) throw Error(name + ': checksum mismatch ' + hash);
    fs.writeFileSync(target, data); console.log(name, data.length, hash);
  }
})().catch(e => { console.error(e.message); process.exit(1); });

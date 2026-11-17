const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const context = { window: {}, URL, Blob, Uint8Array, crypto: crypto.webcrypto, btoa, atob, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, 'voice.js'), 'utf8'), context);
const Voice = context.window.TrinumVoice;
test('voice transfer chunks, reassembles and releases transient audio', async () => {
  const received = [], messages = [];
  const receiver = new Voice({ channel: () => null, received: (id, message) => received.push({ id, message }), notice: () => {} });
  const channel = { readyState: 'open', bufferedAmount: 0, send(raw) { assert.ok(raw.length < 20000); const m = JSON.parse(raw); messages.push(m); receiver.receive('sender', m); } };
  const sender = new Voice({ channel: () => channel, received: () => {}, notice: () => {} });
  const bytes = crypto.randomBytes(45000), blob = new Blob([bytes], { type: 'audio/webm;codecs=opus' });
  sender.draft = { peer: 'receiver', blob, duration: 5, url: URL.createObjectURL(blob) };
  const sent = await sender.send('receiver');
  assert.ok(messages.filter(m => m.type === 'voice-chunk').length > 1);
  assert.equal(received.length, 1); assert.equal(receiver.pending.size, 0); assert.equal(sender.draft, null);
  assert.deepEqual(Buffer.from(await (await fetch(received[0].message.voice.url)).arrayBuffer()), bytes);
  URL.revokeObjectURL(sent.voice.url); URL.revokeObjectURL(received[0].message.voice.url); sender.close(); receiver.close();
});
test('voice receiver rejects oversized, unsafe, incomplete and mismatched audio transfers', () => {
  let accepted = 0; const v = new Voice({ channel: () => null, received: () => accepted++, notice: () => {} });
  const start = { type: 'voice-start', id: 'test', size: 3, mime: 'audio/mp4', duration: 1 };
  assert.equal(v.receive('p', { type: 'message' }), false);
  v.receive('p', { ...start, size: 2 * 1024 * 1024 }); assert.equal(v.pending.size, 0);
  v.receive('p', { ...start, mime: 'image/svg+xml' }); assert.equal(v.pending.size, 0);
  v.receive('p', start); v.receive('p', { type: 'voice-chunk', id: 'wrong', data: 'YWJj' }); v.receive('p', { type: 'voice-end', id: 'test' }); assert.equal(accepted, 0);
  v.receive('p', start); v.receive('p', { type: 'voice-chunk', id: 'test', data: 'Y WJj' }); assert.equal(v.pending.size, 0);
  v.receive('p', start); v.receive('p', { type: 'voice-chunk', id: 'test', data: 'YWJjZA==' }); assert.equal(v.pending.size, 0);
  v.receive('p', start); v.receive('p', { type: 'voice-cancel', id: 'test' }); assert.equal(v.pending.size, 0);
  v.close(); assert.equal(accepted, 0);
});
test('voice accepts Firefox and Safari audio types and reports rejected transfers to the sender', () => {
  const sent = [], notices = [];
  const v = new Voice({ channel: () => ({ readyState: 'open', send: raw => sent.push(JSON.parse(raw)) }), received: () => {}, notice: text => notices.push(text) });
  for (const mime of ['audio/ogg; codecs=opus', 'audio/webm; codecs="opus"', 'audio/mp4; codecs=mp4a.40.2', 'audio/x-m4a', 'audio/aac']) {
    v.receive('p', { type: 'voice-start', id: 'm', size: 3, mime, duration: 1 }); assert.equal(v.pending.size, 1, mime); v.drop('p');
  }
  for (const mime of ['image/svg+xml', 'text/html', 'audio/mp4<script>', 'audio/' + 'x'.repeat(200)]) {
    v.receive('p', { type: 'voice-start', id: 'bad', size: 3, mime, duration: 1 }); assert.equal(v.pending.size, 0, mime);
  }
  assert.ok(sent.every(m => m.type === 'voice-rejected' && m.id === 'bad')); assert.equal(sent.length, 4);
  v.receive('p', { type: 'voice-start', id: 'a', size: 3, mime: 'audio/mp4', duration: 1 });
  v.receive('p', { type: 'voice-start', id: 'b', size: 3, mime: 'audio/mp4', duration: 1 });
  assert.equal(v.pending.get('p').id, 'b', 'a stuck transfer does not block the next one');
  v.receive('p', { type: 'voice-rejected', id: 'x' }); assert.equal(notices.length, 1);
  v.close();
});

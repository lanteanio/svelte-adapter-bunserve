import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRequestLifetime } from '../../src/runtime/handler/request-lifetime.js';
import { counters, requestSignals } from '../../src/runtime/handler/state.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
function open(limit) {
 let input;
 const native = new Request('http://localhost/body', { method: 'POST', duplex: 'half', body: new ReadableStream({ start(out) { input = out; } }) });
 const lifetime = openRequestLifetime(native, limit);
 return { input, lifetime, request: lifetime.request(native.url) };
}
for (const limit of [0, 1, 65536]) {
 test(`body budget permits exactly ${limit} bytes and rejects the next byte`, async () => {
  const { input, lifetime, request } = open(limit);
  const reading = request.arrayBuffer();
  const rejected = assert.rejects(reading, /byte limit/);
  if (limit) input.enqueue(new Uint8Array(limit));
  input.enqueue(new Uint8Array(1));
  await rejected;
  assert.equal(request.signal.reason.name, 'RequestBodyLimitError');
  assert.equal(lifetime.bodyLimitExceeded, true);
  const response = lifetime.response(new Response('app swallowed the body error'), true);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('connection'), 'close');
  await response.text();
  assert.equal(counters.inFlightCount, 0);
  assert.equal(requestSignals.size, 0);
 });
 test(`body budget accepts a complete ${limit} byte body`, async () => {
  const { input, lifetime, request } = open(limit);
  if (limit) input.enqueue(new Uint8Array(limit));
  input.close();
  assert.equal((await request.arrayBuffer()).byteLength, limit);
  const response = lifetime.response(new Response('ok'), true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('connection'), null);
  assert.equal(lifetime.bodyLimitExceeded, false);
 });
}
test('overflow before a late consumer remains a promise rejection', async () => {
 const { input, lifetime, request } = open(1);
 input.enqueue(new Uint8Array(2));
 await turn();
 let reading;
 assert.doesNotThrow(() => { reading = request.text(); });
 await assert.rejects(reading, /byte limit/);
 assert.equal(lifetime.response(new Response(null), true).status, 413);
});
test('overflow after response headers cuts the response short and releases ownership', async () => {
 const { input, lifetime } = open(2);
 let output; let cancelled = 0;
 const response = lifetime.response(new Response(new ReadableStream({ start(out) { output = out; }, cancel() { cancelled++; } })));
 const reader = response.body.getReader();
 output.enqueue(new Uint8Array([1]));
 assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
 const closed = assert.rejects(reader.closed, /byte limit/);
 input.enqueue(new Uint8Array(3));
 await closed;
 await assert.rejects(reader.read(), /byte limit/);
 assert.equal(cancelled, 1);
 assert.equal(counters.inFlightCount, 0);
});
test('an early complete response closes an incomplete upload connection', () => {
 const { lifetime } = open(32);
 const response = lifetime.response(new Response('early'), true);
 assert.equal(response.headers.get('connection'), 'close');
 assert.equal(response.status, 200);
 assert.equal(counters.inFlightCount, 0);
});

test('overflow settles guarded work even when the application never returns', async () => {
 const { input, lifetime } = open(1);
 const held = lifetime.guard(new Promise(() => {}));
 const rejected = assert.rejects(held, /byte limit/);
 input.enqueue(new Uint8Array(2));
 await rejected;
 assert.equal(lifetime.response(new Response(null), true).status, 413);
 assert.equal(counters.inFlightCount, 0);
});

test('a finite budget larger than the queue is observed through bounded pause polls', async () => {
 const { setRuntimeEnv, resetRuntimeEnv } = await import('../../src/runtime/runtime.js');
 const timers = new Set();
 setRuntimeEnv({ timers: {
  set(callback, ms) { assert.equal(ms, 10000); const timer = { callback, unref() {} }; timers.add(timer); return timer; },
  clear(timer) { timers.delete(timer); }
 } });
 try {
  let reads = 0;
  const native = new Request('http://localhost/held', { method: 'POST', duplex: 'half', body: new ReadableStream({
   pull(out) { reads++; out.enqueue(new Uint8Array(reads <= 8 ? 16384 : 1)); }
  }, { highWaterMark: 0 }) });
  const lifetime = openRequestLifetime(native, 128 * 1024);
  lifetime.request(native.url);
  const rejected = assert.rejects(lifetime.guard(new Promise(() => {})), /byte limit/);
  await turn();
  assert.equal(reads, 4, 'initial queue stays at 64 KiB');
  assert.equal(timers.size, 1);
  for (let expected = 5; expected <= 9; expected++) {
   const timer = [...timers][0]; assert.ok(timer); timers.delete(timer); timer.callback();
   await turn();
   assert.equal(reads, expected, 'one additional native read per expired pause');
  }
  await rejected;
  assert.equal(lifetime.response(new Response(null), true).status, 413);
  assert.equal(timers.size, 0);
  assert.equal(counters.inFlightCount, 0);
 } finally { resetRuntimeEnv(); }
});
test('consumer demand and request finish clear a full-queue pause timer', async () => {
 const { setRuntimeEnv, resetRuntimeEnv } = await import('../../src/runtime/runtime.js');
 const timers = new Set();
 setRuntimeEnv({ timers: {
  set(callback, ms) { assert.equal(ms, 10000); const timer = { callback, unref() {} }; timers.add(timer); return timer; },
  clear(timer) { timers.delete(timer); }
 } });
 try {
  const { input, lifetime, request } = open(128 * 1024);
  input.enqueue(new Uint8Array(65536)); await turn();
  const original = [...timers][0]; assert.ok(original);
  const reader = request.body.getReader();
  await reader.read(); await turn();
  assert.equal(timers.has(original), false);
  input.enqueue(new Uint8Array(65536)); await turn();
  assert.equal(timers.size, 1);
  lifetime.finish();
  assert.equal(timers.size, 0);
 } finally { resetRuntimeEnv(); }
});

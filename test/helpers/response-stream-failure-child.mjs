import assert from 'node:assert/strict';
import { connect } from 'node:net';
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { openRequestLifetime } = await import('../../src/runtime/handler/request-lifetime.js');
const { collectImmediate } = await import('../../src/runtime/handler/response-collect.js');
const releases = new Map();
const cancels = new Map();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
 const mode = new URL(request.url).pathname.slice(1);
 if (mode === 'health') return new Response('alive');
 const gate = new Promise(resolve => releases.set(mode, resolve));
 const lifetime = openRequestLifetime(request);
 let sent = false;
 const source = new ReadableStream({ async pull(out) {
  if (!sent) { sent = true; out.enqueue(new TextEncoder().encode('shell\n')); return; }
  await gate;
  if (mode === 'source') out.error(new Error('source failed'));
  else out.enqueue(42);
 }, cancel() { cancels.set(mode, (cancels.get(mode) || 0) + 1); } }, { highWaterMark: 0 });
 const stream = mode === 'continuation' ? (await collectImmediate(source, lifetime)).stream : source;
 return lifetime.response(new Response(stream, { headers: { 'content-type': 'text/plain' } }));
} });
try {
 for (const mode of ['invalid', 'continuation', 'source']) {
  const wire = await new Promise((resolve, reject) => {
   const socket = connect(server.port, '127.0.0.1', () => socket.write(`GET /${mode} HTTP/1.1\r\nHost: localhost\r\n\r\n`));
   let text = ''; let released = false; let reset = false;
   socket.on('data', chunk => {
    text += chunk.toString();
    if (!released && text.includes('shell\n')) { released = true; releases.get(mode)(); }

   });
   socket.on('close', () => resolve({ text, reset }));
   socket.on('error', error => { if (error.code === 'ECONNRESET') reset = true; else reject(error); });
   socket.setTimeout(5000, () => socket.destroy(new Error(mode + ' timed out')));
  });
  assert.match(wire.text, /6\r\nshell\n\r\n/);
  assert.doesNotMatch(wire.text, /0\r\n\r\n/, 'a failed body must not look complete');
  assert.equal(wire.text.split('HTTP/1.1').length - 1, 1, 'the failed connection carries only its first response');
  if (mode !== 'source') assert.equal(cancels.get(mode), 1);
 }
 console.log('3 native response failure termination cases passed');
} finally { server.stop(true); }

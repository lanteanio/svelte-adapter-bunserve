// Build first: cd test/fixtures/body-budget && node node_modules/vite/bin/vite.js build
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { assertPortFree, serverEnv } from './harness.mjs';
const port = Number(process.env.BODY_BUDGET_PORT || 19287);
const base = `http://127.0.0.1:${port}`;
const build = fileURLToPath(new URL('../fixtures/body-budget/build/index.js', import.meta.url));
let checks = 0;
function raw(path, bytes, { declared = false, stream = false, waitClose = false, segmented = false, timeoutMs = 5000 } = {}) {
 return new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1');
  let data = ''; let sent = false;
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`wire timeout ${path}: ${data}`)); }, timeoutMs);
  socket.on('connect', () => {
   socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\n${declared ? 'Content-Length: ' + bytes : 'Transfer-Encoding: chunked'}\r\nConnection: close\r\n\r\n`);
   if (!stream) write();
  });
  async function write() {
   if (sent) return; sent = true;
   if (segmented) {
    for (let offset = 0; offset < bytes; offset += 16384) {
     const length = Math.min(16384, bytes - offset);
     socket.write(length.toString(16) + '\r\n' + 'a'.repeat(length) + '\r\n');
     await Bun.sleep(10);
    }
    socket.write('0\r\n\r\n');
   } else if (declared) socket.write('a'.repeat(bytes));
   else socket.write((bytes ? bytes.toString(16) + '\r\n' + 'a'.repeat(bytes) + '\r\n' : '') + '0\r\n\r\n');
  }
  socket.on('data', chunk => {
   data += chunk;
   if (stream && data.includes('prefix')) write();
   const boundary = data.indexOf('\r\n\r\n');
   if (boundary === -1) return;
   const headers = data.slice(0, boundary);
   const length = /content-length: (\d+)/i.exec(headers);
   if (!waitClose && length && Buffer.byteLength(data.slice(boundary + 4)) >= Number(length[1])) socket.destroy();
   else if (!waitClose && /transfer-encoding: chunked/i.test(headers) && data.endsWith('0\r\n\r\n')) socket.destroy();
  });
  socket.on('error', error => { if (!data) { clearTimeout(timer); reject(error); } });
  socket.on('close', () => { clearTimeout(timer); resolve(data); });
 });
}
async function run(ceiling, check) {
 await assertPortFree(port);
 const child = Bun.spawn([process.execPath, build], { env: serverEnv({ PORT: String(port), HOST: '127.0.0.1', BODY_SIZE_LIMIT: String(ceiling) }), stdout: 'pipe', stderr: 'pipe' });
 const output = new Response(child.stdout).text(); const errors = new Response(child.stderr).text();
 try {
  const deadline = Date.now() + 10000;
  for (;;) {
   if (child.exitCode !== null) throw new Error(`fixture exited ${child.exitCode}: ${await output} ${await errors}`);
   try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
   assert.ok(Date.now() < deadline, 'fixture became ready');
   await Bun.sleep(10);
  }
  await check();
 } finally { child.kill(); await child.exited; }
}
await run(524288, async () => {
 for (const path of ['/base/echo', '/base/%65cho?x=1', '/base/auth', '/base/admin/echo']) {
  for (const declared of [true, false]) for (const bytes of [8, 9]) {
   const data = await raw(path, bytes, { declared });
   assert.match(data, new RegExp(`^HTTP/1.1 ${bytes === 8 ? 200 : 413} `), `${path} ${bytes} declared=${declared}: ${data}`);
   checks++;
  }
 }
 for (const [path, bytes, status] of [
  ['/base/tiny/child', 3, 200], ['/base/tiny/child', 4, 413],
  ['/base/tiny%2Fchild', 4, 413], ['/base/tinyish', 4, 200],
  ['/base/zero', 0, 200], ['/base/zero', 1, 413]
 ]) { assert.match(await raw(path, bytes), new RegExp(`^HTTP/1.1 ${status} `)); checks++; }
 for (const path of ['/base/echo', '/base/auth', '/base/admin/echo']) {
  assert.match(await raw(path + '?held', 9), /^HTTP\/1.1 413 /); checks++;
 }
 assert.match(await raw('/base/held-large?held', 131073, { segmented: true, waitClose: true, timeoutMs: 90000 }), /^HTTP\/1.1 413 /); checks++;
 const response = await fetch(base + '/base/echo');
 assert.equal(response.status, 200); assert.equal(await response.text(), 'get'); checks++;
 const early = await raw('/base/echo?early', 0, { stream: true, waitClose: true });
 assert.match(early, /^HTTP\/1.1 200 /); assert.match(early, /connection: close/i); assert.match(early, /early/); checks++;
 const streaming = await raw('/base/echo?stream', 9, { stream: true, waitClose: true });
 assert.match(streaming, /^HTTP\/1.1 200 /); assert.match(streaming, /prefix/); assert.ok(!streaming.includes('complete'));
 assert.match(streaming, /transfer-encoding: chunked/i);
 assert.ok(!streaming.endsWith('0\r\n\r\n'), 'overflow must not terminate the chunk stream cleanly'); checks++;
});
await run(4, async () => {
 for (const path of ['/base/echo', '/base/auth', '/base/admin/echo']) {
  const response = await fetch(base + path, { method: 'POST', body: '12345' });
  assert.equal(response.status, 413); await response.text(); checks++;
 }
});
await run(0, async () => {
 assert.match(await raw('/base/echo', 9), /^HTTP\/1.1 413 /); checks++;
 assert.match(await raw('/base/unbounded', 524289), /^HTTP\/1.1 200 /); checks++;
});
console.log(`${checks} generated-server body budget checks passed`);

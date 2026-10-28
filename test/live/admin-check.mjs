import assert from 'node:assert/strict';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
const port = 8873;
await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], { env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe' });
try {
 await waitForServer(proc, port);
 const base = `http://127.0.0.1:${port}`;
 assert.equal((await fetch(base + '/__realtime/status')).status, 401);
 for (const method of ['GET', 'HEAD', 'POST']) {
  const response = await fetch(base + '/__realtime/status', { method, headers: { authorization: 'Bearer admin' }, ...(method === 'POST' ? { body: 'hello' } : {}) });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('date'), 'Sun, 06 Nov 1994 08:49:37 GMT');
  assert.equal(response.headers.get('transfer-encoding'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(response.headers.getSetCookie(), ['first=1', 'second=2']);
  if (method === 'HEAD') { assert.equal(await response.text(), ''); assert.ok(Number(response.headers.get('content-length')) > 0); }
  else assert.deepEqual(await response.json(), { method, pathname: '/__realtime/status', body: method === 'POST' ? 'hello' : '' });
 }
 for (const mode of ['throw', 'zero']) {
  const response = await fetch(base + '/__realtime/status?' + mode, { headers: { authorization: 'Bearer admin' } });
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'internal error' });
 }
 assert.equal((await fetch(base + '/%5f_realtime/status')).status, 400);
 assert.equal((await fetch(base + '/__realtime%2fstatus')).status, 400);
 console.log('8 production admin native cases passed');
} finally { proc.kill(); await proc.exited; }

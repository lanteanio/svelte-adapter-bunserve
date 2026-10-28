import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = { authPath: '/auth', authPathRateLimit: 0, authPathRequireOrigin: false, adminPath: '/admin' };
globalThis.BODY_LIMIT_RULES = [{ path: '/auth', bytes: 3 }, { path: '/admin', prefix: true, bytes: 3 }];
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { tryAuthEndpoint } = await import('../../src/runtime/handler/auth.js');
const { tryAdminEndpoint } = await import('../../src/runtime/handler/admin.js');
const { counters } = await import('../../src/runtime/handler/state.js');
const srv = { requestIP: () => ({ address: '127.0.0.1' }) };
for (const door of ['auth', 'admin']) {
 const path = door === 'auth' ? '/auth' : '/admin/echo';
 const call = request => door === 'auth' ? tryAuthEndpoint(request, srv, path) : tryAdminEndpoint(request, path);
 const hooks = handler => door === 'auth' ? { authenticate: ({ request }) => handler(request) } : { admin: handler };
 test(`${door} refuses declared overbudget before calling its hook`, async () => {
  let called = 0;
  __setHooks(hooks(() => { called++; return new Response('ok'); }));
  const result = await call(new Request('http://localhost' + path, { method: 'POST', body: 'abcd', headers: { host: 'localhost', 'content-length': '4' } }));
  assert.equal(result.status, 413); assert.equal(called, 0);
  assert.equal(result.headers.get('connection'), 'close');
 });
 for (const bytes of [3, 4]) {
  test(`${door} enforces the same rule for a chunked ${bytes} byte body`, async () => {
   let request;
   __setHooks(hooks(async req => { request = req; try { return new Response(await req.text()); } catch { return new Response('swallowed'); } }));
   const result = await call(new Request('http://localhost' + path, { method: 'POST', duplex: 'half', headers: { host: 'localhost', 'transfer-encoding': 'chunked' }, body: new ReadableStream({ start(out) { out.enqueue(new Uint8Array(bytes).fill(97)); out.close(); } }) }));
   assert.equal(result.status, bytes === 3 ? 200 : 413);
   assert.equal(request.signal.aborted, bytes > 3);
   if (bytes === 3) assert.equal(await result.text(), 'aaa'); else await result.text();
   assert.equal(counters.inFlightCount, 0);
  });
 }
}

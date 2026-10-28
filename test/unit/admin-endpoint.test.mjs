import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = {};
globalThis.WS_PATH = '/ws';
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { tryAdminEndpoint } = await import('../../src/runtime/handler/admin.js');
afterEach(() => __setHooks({}));
const request = (method = 'GET', init = {}) => new Request('http://localhost/__realtime/status', { method, headers: { host: 'localhost' }, ...init });

test('admin mount exists only for an exported handler and matches the reserved prefix', async () => {
 assert.equal(tryAdminEndpoint(request(), '/__realtime/status'), null);
 __setHooks({ admin: () => new Response('ok') });
 assert.equal(tryAdminEndpoint(request(), '/ordinary'), null);
 assert.equal(tryAdminEndpoint(request(), '/__realtime'), null);
 assert.equal(await (await tryAdminEndpoint(request(), '/__realtime/status')).text(), 'ok');
});
test('admin receives the full request and relays app headers with transport-owned framing', async () => {
 __setHooks({ admin: async req => new Response(await req.text(), { headers: { date: 'Sun, 06 Nov 1994 08:49:37 GMT', 'transfer-encoding': 'chunked', 'content-length': '999', 'set-cookie': 'a=1' } }) });
 const response = await tryAdminEndpoint(request('POST', { body: 'payload' }), '/__realtime/status');
 assert.equal(await response.text(), 'payload');
 for (const name of ['date', 'content-length', 'transfer-encoding']) assert.equal(response.headers.get(name), null);
 assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
 assert.deepEqual(response.headers.getSetCookie(), ['a=1']);
});
test('admin HEAD reads response length without returning its payload', async () => {
 __setHooks({ admin: () => new Response('hello') });
 const response = await tryAdminEndpoint(request('HEAD'), '/__realtime/status');
 assert.equal(response.headers.get('content-length'), '5');
 assert.equal(await response.text(), '');
});
test('admin rejects exceptions and status-zero responses without exposing error text', async () => {
 for (const admin of [() => { throw new Error('private'); }, () => Response.error(), () => ({ status: 200 })]) {
  __setHooks({ admin });
  const response = await tryAdminEndpoint(request(), '/__realtime/status');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal error' });
 }
});

test('admin preserves an encoded separator inside its mounted prefix', async () => {
 let received;
 __setHooks({ admin: request => { received = new URL(request.url).pathname; return new Response('ok'); } });
 const target = '/__realtime/..%2Freflect';
 const response = await tryAdminEndpoint(new Request('http://localhost' + target, { headers: { host: 'localhost' } }), target);
 assert.equal(response.status, 200);
 assert.equal(received, target);
});

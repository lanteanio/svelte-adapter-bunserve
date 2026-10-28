import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTransportMetrics } from '../../src/runtime/utils/http-transport-metrics.js';

function fixture() {
 let clock = 1000;
 const counts = [], durations = [];
 const metrics = createHttpTransportMetrics({ inc: labels => counts.push(labels) }, { observe: (labels, value) => durations.push({ labels, value }) }, () => clock);
 return { metrics, counts, durations, advance: value => { clock += value; } };
}
test('HTTP RED bounds labels and records each returned status once', () => {
 const f = fixture();
 for (const [method, status, outcome] of [['GET', 200, 'ok'], ['HEAD', 304, 'ok'], ['POST', 404, 'client_error'], ['PUT', 503, 'server_error'], ['CUSTOM', 200, 'ok']]) {
  const request = { method, signal: new AbortController().signal, url: 'http://localhost/private/path?token=secret' };
  f.metrics.begin(request); f.advance(250);
  f.metrics.response(request, new Response(null, { status }));
  f.metrics.response(request, new Response(null));
  assert.deepEqual(f.counts.at(-1), { method: method === 'CUSTOM' ? 'other' : method.toLowerCase(), outcome });
  assert.equal(f.durations.at(-1).value, 0.25);
  assert.equal(Object.isFrozen(f.counts.at(-1)), true);
 }
 assert.equal(f.counts.length, 5);
});
test('streaming completion records lifetime and abort wins exactly once', () => {
 const f = fixture(); const control = new AbortController();
 const request = new Request('http://localhost/', { signal: control.signal });
 f.metrics.begin(request); f.advance(10); f.metrics.streaming(request, 201);
 f.metrics.response(request, new Response(null, { status: 201 }));
 assert.equal(f.counts.length, 0);
 f.advance(990); control.abort(); f.metrics.finish(request); f.metrics.failed(request);
 assert.deepEqual(f.counts, [{ method: 'get', outcome: 'aborted' }]);
 assert.equal(f.durations[0].value, 1);
});
test('streaming EOF, explicit stream cancellation, and thrown handlers have distinct terminal outcomes', () => {
 const f = fixture();
 for (const outcome of ['client_error', 'aborted', 'server_error']) {
  const request = new Request('http://localhost/'); f.metrics.begin(request);
  if (outcome === 'server_error') f.metrics.failed(request);
  else { f.metrics.streaming(request, 404); f.metrics.finish(request, outcome === 'aborted' ? outcome : undefined); }
  f.metrics.finish(request); assert.equal(f.counts.at(-1).outcome, outcome);
 }
 assert.equal(f.counts.length, 3);
});
test('successful upgrades are discarded and absent histograms never read the clock', () => {
 let reads = 0, writes = 0;
 const metrics = createHttpTransportMetrics({ inc: () => writes++ }, undefined, () => { reads++; return 1; });
 const controller = new AbortController(); const request = new Request('http://localhost/', { signal: controller.signal });
 metrics.begin(request); metrics.response(request, undefined); controller.abort();
 assert.equal(writes, 0); assert.equal(reads, 0);
 const normal = new Request('http://localhost/'); metrics.begin(normal); metrics.response(normal, new Response());
 assert.equal(writes, 1); assert.equal(reads, 0);
});

test('request lifetime reports streamed EOF and producer failure through the installed tracker', async () => {
 const { configureHttpTransportMetrics } = await import('../../src/runtime/utils/http-transport-metrics.js');
 const { openRequestLifetime } = await import('../../src/runtime/handler/request-lifetime.js');
 const module = await import('../../src/runtime/utils/http-transport-metrics.js');
 const values = [];
 configureHttpTransportMetrics({ inc: labels => values.push(labels) }, undefined, () => 0);
 try {
  for (const fail of [false, true]) {
   const request = new Request('http://localhost/'); module.httpMetrics.begin(request);
   const lifetime = openRequestLifetime(request);
   const response = lifetime.response(new Response(new ReadableStream({ start(out) {
    if (fail) out.error(new Error('producer')); else { out.enqueue(new Uint8Array([1])); out.close(); }
   } }), { status: 503 }));
   module.httpMetrics.response(request, response);
   if (fail) await assert.rejects(response.arrayBuffer(), /producer/); else await response.arrayBuffer();
   lifetime.finish();
  }
  assert.deepEqual(values, [{ method: 'get', outcome: 'server_error' }, { method: 'get', outcome: 'aborted' }]);
 } finally { configureHttpTransportMetrics(); }
});

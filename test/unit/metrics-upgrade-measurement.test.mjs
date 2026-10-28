import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../../', import.meta.url));
function child(source) {
 const result = spawnSync(process.execPath, ['--conditions=bunserve-test', '--input-type=module', '-e', source], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
 assert.equal(result.status, 0, result.stderr + result.stdout);
}
for (const configured of [false, true]) {
 test(`upgrade gauges observe held, aborted and completed attempts with admission ${configured}`, () => child(`
  import assert from 'node:assert/strict';
  import './test/helpers/configured-metrics.mjs';
  import { HANDSHAKE } from './test/helpers/handshake.mjs';
  globalThis.ENV_PREFIX = ''; globalThis.WS_PATH = '/ws';
  globalThis.WS_OPTIONS = { allowedOrigins: 'any', upgradeAdmission: ${configured ? '{ maxConcurrent: 4 }' : 'undefined'} };
  const { metricsSnapshot } = await import('./src/runtime/handler/metrics.js');
  const { tryUpgrade } = await import('./src/runtime/handler/upgrade.js');
  const { __setHooks } = await import('./test/helpers/ws-handler-stub.mjs');
  const value = async () => Number((await metricsSnapshot()).match(/^upgrade_inflight (.+)$/m)[1]);
  const requests = [];
  __setHooks({ upgrade: () => new Promise(resolve => requests.push(resolve)) });
  const server = { upgrade() { return true; } };
  const abort = new AbortController();
  const request = signal => new Request('http://localhost/ws', { headers: HANDSHAKE, signal });
  const one = tryUpgrade(request(abort.signal), server, '/ws');
  const two = tryUpgrade(request(new AbortController().signal), server, '/ws');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await value(), 2);
  abort.abort();
  assert.equal(await value(), 1, 'abort releases the measurement before the application hook settles');
  for (const resolve of requests) resolve({});
  await Promise.all([one, two]);
  assert.equal(await value(), 0, 'finally cannot decrement an aborted attempt twice');
  __setHooks({ upgrade: () => { throw new Error('controlled refusal'); } });
  assert.equal((await tryUpgrade(request(new AbortController().signal), server, '/ws')).status, 500);
  assert.equal(await value(), 0);
  const already = new AbortController(); already.abort();
  await tryUpgrade(request(already.signal), server, '/ws');
  assert.equal(await value(), 0);
 `));
}
test('pacing gauges read actual queue depth, age and drain completion', () => child(`
 import assert from 'node:assert/strict';
 import './test/helpers/configured-metrics.mjs';
 globalThis.ENV_PREFIX = ''; globalThis.WS_PATH = '/ws';
 globalThis.WS_OPTIONS = { upgradeAdmission: { perTickBudget: 1, maxDeferred: 4 } };
 const { setRuntimeEnv } = await import('./src/runtime/runtime.js');
 let now = 1000; const turns = [];
 setRuntimeEnv({ clock: { monotonic: () => now }, timers: { setImmediate: fn => { turns.push(fn); return {}; } } }, { force: true });
 const { metricsSnapshot } = await import('./src/runtime/handler/metrics.js');
 const { upgradeAdmission } = await import('./src/runtime/handler/admission.js');
 const value = (text, name) => Number(text.match(new RegExp('^' + name + ' (.+)$', 'm'))[1]);
 upgradeAdmission.admit(() => {}); upgradeAdmission.admit(() => {});
 now += 2500;
 let text = await metricsSnapshot();
 assert.equal(value(text, 'upgrade_deferred_depth'), 1);
 assert.equal(value(text, 'upgrade_deferred_oldest_age_seconds'), 2.5);
 turns.shift()();
 text = await metricsSnapshot();
 assert.equal(value(text, 'upgrade_deferred_depth'), 0);
 assert.equal(value(text, 'upgrade_deferred_oldest_age_seconds'), 0);
`));

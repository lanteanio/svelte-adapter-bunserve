import assert from 'node:assert/strict';
import { buildPath, serverEnv, waitForServer, assertPortFree } from './harness.mjs';

const port = 8894;
await assertPortFree(port);
const proc = Bun.spawn(['bun', buildPath()], { env: serverEnv({ PORT: String(port), HOST: '127.0.0.1' }), stdout: 'ignore', stderr: 'pipe' });
try {
 await waitForServer(proc, port);
 const route = await (await fetch(`http://127.0.0.1:${port}/shared-counter`)).json();
 const hook = await (await fetch(`http://127.0.0.1:${port}/__ws/auth?mode=shared-counter`, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' } })).json();
 const again = await (await fetch(`http://127.0.0.1:${port}/shared-counter`)).json();
 assert.equal(hook.value, route.value + 1);
 assert.equal(again.value, hook.value + 1);
 console.log('handler and route share one module instance');
} finally {
 proc.kill();
 await proc.exited;
}

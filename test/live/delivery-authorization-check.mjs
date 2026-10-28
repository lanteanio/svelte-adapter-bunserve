// An external deadline also catches a reentrant policy that monopolizes its
// worker's event loop and prevents an in-process timeout from firing.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('../helpers/delivery-live-child.mjs', import.meta.url));
const proc = Bun.spawn([process.execPath, '--conditions=bunserve-test', child], {
	stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env, NODE_ENV: 'test' }
});
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 30_000);
const [code, stdout, stderr] = await Promise.all([
	proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()
]);
clearTimeout(timer);
assert.equal(timedOut, false, `delivery authorization monopolized its worker\n${stdout}\n${stderr}`);
assert.equal(code, 0, `delivery authorization failed\n${stdout}\n${stderr}`);
console.log(stdout.trim());

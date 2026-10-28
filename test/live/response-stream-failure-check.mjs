import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const child = Bun.spawn([process.execPath, '--conditions=bunserve-test', fileURLToPath(new URL('../helpers/response-stream-failure-child.mjs', import.meta.url))], { stdout: 'inherit', stderr: 'inherit' });
const timer = setTimeout(() => child.kill(), 20000);
try { assert.equal(await child.exited, 0); }
finally { clearTimeout(timer); }

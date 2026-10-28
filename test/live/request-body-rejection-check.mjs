import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const child = Bun.spawn([
	process.execPath, '--conditions=bunserve-test',
	fileURLToPath(new URL('../helpers/request-body-live-child.mjs', import.meta.url))
], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
const timer = setTimeout(() => child.kill(), 30000);
try { assert.equal(await child.exited, 0, 'upload disconnects must not terminate the worker'); }
finally { clearTimeout(timer); }
console.log('request-body-rejection: 5 native cases passed');

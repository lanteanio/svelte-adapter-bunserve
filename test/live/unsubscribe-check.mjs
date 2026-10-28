import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync(process.execPath, [
	'--conditions=bunserve-test', '--preload', './test/helpers/test-env.mjs',
	'./test/helpers/unsubscribe-live-child.mjs'
], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /7 topic shapes passed/);
console.log(result.stdout.trim());

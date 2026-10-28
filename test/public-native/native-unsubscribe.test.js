import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('wire unsubscribe releases native-only and tracked topic memberships', () => {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const result = spawnSync(process.execPath, [
		'--conditions=bunserve-test', '--preload', './test/helpers/test-env.mjs',
		'./test/helpers/unsubscribe-live-child.mjs'
	], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
	expect(result.error, result.stderr || result.error?.message).toBeUndefined();
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.stdout).toContain('native unsubscribe: 7 topic shapes passed');
}, 15000);

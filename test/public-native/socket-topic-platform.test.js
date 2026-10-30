import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a topic the hook socket names as bytes or as the empty string is the one the platform publishes to', () => {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const result = spawnSync(process.execPath, [
		'--conditions=bunserve-test', '--preload', './test/helpers/test-env.mjs',
		'./test/helpers/socket-topic-live-child.mjs'
	], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
	expect(result.error, result.stderr || result.error?.message).toBeUndefined();
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.stdout).toContain('socket topics: 4 spellings reach the platform');
}, 15000);

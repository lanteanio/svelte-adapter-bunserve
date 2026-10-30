import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRuntimeEnv, resetRuntimeEnv } from '../../src/runtime/runtime.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform } = await import('../../src/runtime/handler/platform.js');

test('platform.hlc stamps a non-decreasing wall with a logical tiebreaker from the runtime seams', () => {
	let wall = 700;
	let draws = 0;
	setRuntimeEnv({
		clock: { now: () => wall },
		rng: { uuid: () => `${++draws}`.padStart(8, '0') + '-1234-1234-1234-123456789abc' }
	});
	try {
		assert.equal(draws, 0, 'the clock draws no node identity until it is read');
		const stamps = [];
		for (const next of [700, 650, 700, 800]) {
			wall = next;
			stamps.push(platform.hlc());
		}
		assert.equal(draws, 1);
		assert.deepEqual(stamps, [
			{ wall: 700, logical: 0, nodeId: '00000001' },
			{ wall: 700, logical: 1, nodeId: '00000001' },
			{ wall: 700, logical: 2, nodeId: '00000001' },
			{ wall: 800, logical: 0, nodeId: '00000001' }
		]);
	} finally {
		resetRuntimeEnv();
	}
});

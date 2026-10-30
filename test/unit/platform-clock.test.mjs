import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { now as runtimeNow, monotonicNow, setRuntimeEnv, resetRuntimeEnv } from '../../src/runtime/runtime.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform } = await import('../../src/runtime/handler/platform.js');

test('platform.now and platform.monotonic read the runtime now and monotonic seams', () => {
	setRuntimeEnv({
		clock: { now: () => 1000, wallEpoch: () => 2000, monotonic: () => 3000, processMonotonic: () => 4000 }
	});
	try {
		assert.equal(platform.now(), 1000);
		assert.equal(platform.monotonic(), 3000);
		assert.equal(platform.hlc().wall, platform.now(), 'hlc() stamps from the same clock now() reads');
	} finally {
		resetRuntimeEnv();
	}
});

test('platform.now is the cached runtime wall clock and advances on the runtime tick', async () => {
	const first = platform.now();
	assert.equal(first, runtimeNow());
	// The cache refreshes from a timer, so a synchronous span that outlasts a
	// few wall milliseconds still reads the value cached before it.
	const spinUntil = Date.now() + 5;
	while (Date.now() < spinUntil) { /* spin */ }
	assert.equal(platform.now(), first);
	assert.ok(Date.now() > first, 'the exact wall clock moved past the cached reading');
	// The refresher ticks about once a second; yield turns until it has.
	const deadline = performance.now() + 5000;
	while (platform.now() === first && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(platform.now() > first, 'the cached clock advanced on the runtime tick');
	assert.ok(Math.abs(platform.now() - Date.now()) <= 1500);
});

test('platform.monotonic is epoch-anchored and never goes backward', () => {
	const a = platform.monotonic();
	assert.ok(Math.abs(a - monotonicNow()) < 50);
	// Anchored at the wall time of performance.now() === 0, not at process start.
	assert.ok(Math.abs(a - Date.now()) < 5000, 'reads near the wall epoch');
	let prev = a;
	for (let i = 0; i < 100000; i++) {
		const v = platform.monotonic();
		assert.ok(v >= prev);
		prev = v;
	}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { shutdownBudget, runShutdownCleanup } from '../../src/runtime/handler/shutdown.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../../src/runtime/runtime.js';

test('zero budget waits for async and once cleanup listeners with null context', async () => {
	const emitter = new EventEmitter();
	const budget = shutdownBudget(0);
	let resolve;
	let finished = false;
	emitter.once('sveltekit:shutdown', async function (reason, context) {
		assert.equal(this, emitter);
		assert.equal(reason, 'SIGTERM');
		assert.deepEqual(context, { reason: 'SIGTERM', signal: null, deadline: null });
		await new Promise((r) => { resolve = r; });
		finished = true;
	});
	try {
		const pending = runShutdownCleanup('SIGTERM', budget, emitter);
		assert.equal(finished, false);
		assert.equal(emitter.listenerCount('sveltekit:shutdown'), 0);
		resolve();
		assert.equal(await pending, true);
		assert.equal(finished, true);
	} finally { budget.clear(); }
});

test('one deadline aborts a hung phase and is shared with every later phase', async () => {
	let expire;
	let cleared = false;
	let clock = 0;
	setRuntimeEnv({ clock: { wallEpoch: () => 1000, monotonic: () => clock }, timers: {
		set: (cb, ms) => { expire = cb; assert.equal(ms, 2000); return 123; },
		clear: (id) => { assert.equal(id, 123); cleared = true; }
	} }, { force: true });
	const budget = shutdownBudget(2);
	try {
		assert.equal(budget.deadline, 3000);
		const pending = budget.wait(new Promise(() => {}));
		clock = 2000;
		expire();
		assert.equal(await pending, false);
		assert.equal(budget.signal.aborted, true);
		assert.equal(await budget.wait(Promise.resolve()), false);
	} finally { budget.clear(); resetRuntimeEnv(); }
	assert.equal(cleared, true);
});

test('cleanup contains throws and rejections while still awaiting other listeners', async () => {
	const originalError = console.error;
	let errors = 0;
	console.error = () => { errors++; };
	const emitter = new EventEmitter();
	const budget = shutdownBudget(0);
	let finished = false;
	emitter.on('sveltekit:shutdown', () => { throw Error('sync'); });
	emitter.on('sveltekit:shutdown', async () => { throw Error('async'); });
	emitter.on('sveltekit:shutdown', async () => { await Promise.resolve(); finished = true; });
	try {
		assert.equal(await runShutdownCleanup('SIGINT', budget, emitter), false);
		assert.equal(finished, true);
		assert.equal(errors, 2);
	} finally { budget.clear(); console.error = originalError; }
});

test('unlimited shutdown keeps an interval alive and long budgets avoid timer overflow', () => {
	let clock = 0;
	let expire;
	const delays = [];
	let intervals = 0;
	let cleared = 0;
	setRuntimeEnv({ clock: { monotonic: () => clock }, timers: {
		set: (cb, delay) => { expire = cb; delays.push(delay); return 1; },
		clear: () => {},
		setInterval: () => { intervals++; return 2; },
		clearInterval: (id) => { assert.equal(id, 2); cleared++; }
	} }, { force: true });
	try {
		const unlimited = shutdownBudget(0);
		assert.equal(intervals, 1);
		unlimited.clear();
		assert.equal(cleared, 1);
		const long = shutdownBudget(3_000_000);
		assert.deepEqual(delays, [2147483647]);
		clock = 2147483647;
		expire();
		assert.equal(long.signal.aborted, false);
		assert.deepEqual(delays, [2147483647, 852516353]);
		clock = 3_000_000_000;
		expire();
		assert.equal(long.signal.aborted, true);
		long.clear();
	} finally { resetRuntimeEnv(); }
});

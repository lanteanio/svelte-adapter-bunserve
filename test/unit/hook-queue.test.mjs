import test from 'node:test';
import assert from 'node:assert/strict';

import { createHookQueue } from '../../src/runtime/utils/hook-queue.js';

/** A task whose settlement this test controls. */
function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve: /** @type {any} */ (resolve) };
}

test('concurrency is a real bound: the (N+1)th required task waits', () => {
	const q = createHookQueue({ concurrency: 2, maxQueued: 8 });
	const gates = [deferred(), deferred(), deferred()];
	assert.equal(q.enqueue(() => gates[0].promise, true), 'ran');
	assert.equal(q.enqueue(() => gates[1].promise, true), 'ran');
	assert.equal(q.enqueue(() => gates[2].promise, true), 'queued');
	assert.equal(q.running(), 2);
	assert.equal(q.queued(), 1);
});

test('a queued task starts when a running one settles', async () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 8 });
	const first = deferred();
	let secondStarted = false;
	q.enqueue(() => first.promise, true);
	q.enqueue(() => {
		secondStarted = true;
		return Promise.resolve();
	}, true);
	assert.equal(secondStarted, false, 'must not run while the slot is taken');
	first.resolve();
	await first.promise;
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(secondStarted, true);
	assert.equal(q.queued(), 0);
});

test('the bound counts a task for as long as it is SUSPENDED, not just called', () => {
	// The distinction the whole queue rests on: a hook that returns a pending
	// promise at its first await still occupies its slot.
	const q = createHookQueue({ concurrency: 1, maxQueued: 8 });
	const held = deferred();
	q.enqueue(() => held.promise, true);
	assert.equal(q.enqueue(() => Promise.resolve(), true), 'queued');
});

test('speculative work is refused rather than queued once the slots are full', () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 8 });
	q.enqueue(() => deferred().promise, true);
	assert.equal(q.enqueue(() => Promise.resolve(), false), 'refused');
	assert.equal(q.queued(), 0, 'a speculative task must not consume queue space');
});

test('speculative work still RUNS when there is a free slot', () => {
	const q = createHookQueue({ concurrency: 2, maxQueued: 8 });
	q.enqueue(() => deferred().promise, true);
	assert.equal(q.enqueue(() => Promise.resolve(), false), 'ran');
});

test('a required task past the queue reports overflow rather than being dropped', () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 2 });
	q.enqueue(() => deferred().promise, true);
	assert.equal(q.enqueue(() => Promise.resolve(), true), 'queued');
	assert.equal(q.enqueue(() => Promise.resolve(), true), 'queued');
	assert.equal(q.enqueue(() => Promise.resolve(), true), 'overflow');
});

test('a rejecting task releases its slot', async () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 4 });
	q.enqueue(() => Promise.reject(new Error('hook blew up')), true);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(q.running(), 0);
	assert.equal(q.enqueue(() => Promise.resolve(), true), 'ran');
});

test('a task that throws SYNCHRONOUSLY releases its slot and does not escape', async () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 4 });
	assert.doesNotThrow(() =>
		q.enqueue(() => {
			throw new Error('sync throw');
		}, true)
	);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(q.running(), 0);
});

test('a non-promise return settles the slot', async () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 4 });
	q.enqueue(() => undefined, true);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(q.running(), 0);
});

test('clear() drops what is waiting and refuses anything later', async () => {
	const q = createHookQueue({ concurrency: 1, maxQueued: 4 });
	const held = deferred();
	let laterRan = false;
	q.enqueue(() => held.promise, true);
	q.enqueue(() => {
		laterRan = true;
		return Promise.resolve();
	}, true);
	q.clear();
	assert.equal(q.queued(), 0);
	held.resolve();
	await held.promise;
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(laterRan, false, 'a cleared queue must not resume against a dead socket');
	assert.equal(q.enqueue(() => Promise.resolve(), true), 'refused');
});

test('one connection cannot exceed the bound by pipelining, however many it sends', () => {
	// The attack the queue exists for: 10,000 releases arriving in one read
	// burst, synchronously, before any hook resolves.
	const q = createHookQueue({ concurrency: 64, maxQueued: 1024 });
	let peak = 0;
	for (let i = 0; i < 10_000; i++) {
		q.enqueue(() => deferred().promise, true);
		if (q.running() > peak) peak = q.running();
	}
	assert.equal(peak, 64, 'concurrent app hooks must never exceed the configured bound');
	assert.equal(q.queued(), 1024, 'and the backlog is bounded too');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The runtime handler modules read values the build freezes into the bundle.
// Setting them here is what lets the per-connection bounds be tested without a
// build, a server, or a socket; the import has to be dynamic so it happens
// after the assignment rather than being hoisted above it.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const {
	MAX_CONTROL_EGRESS_BYTES,
	beginPendingRelease,
	chargeControlEgress,
	clearPendingReleases,
	clearUnsubscribeHooks,
	endPendingRelease,
	hasGateHeadroom,
	pendingReleaseTopics,
	runUnsubscribeHook,
	withGateCounted
} =
	await import('../../src/runtime/handler/ws-state.js');

/** A stand-in for the socket facade: only `getUserData` is ever reached. */
function fakeWs() {
	const ud = {};
	return { getUserData: () => ud };
}

/** A socket that has gone away. Bun's facade throws once it is closed. */
function closedWs() {
	return {
		getUserData() {
			throw new Error('closed');
		}
	};
}

/** @returns {{ promise: Promise<void>, resolve: () => void, reject: (e: Error) => void }} */
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test('the control-egress budget defaults to 4MB', () => {
	assert.equal(MAX_CONTROL_EGRESS_BYTES, 4 * 1024 * 1024);
});

test('control egress is charged per connection, not per process', () => {
	const a = fakeWs();
	const b = fakeWs();
	assert.equal(chargeControlEgress(a, MAX_CONTROL_EGRESS_BYTES), true);
	assert.equal(chargeControlEgress(a, 1), false);
	// One socket exhausting its window must not cut every other connection.
	assert.equal(chargeControlEgress(b, 1), true);
});

test('a closed socket is not charged and is not reported as flooding', () => {
	// Answering false here would cut a connection that is already gone, and
	// worse, report the flood reason for a socket that never sent anything.
	assert.equal(chargeControlEgress(closedWs(), 1), true);
});

test('a connection has gate headroom until exactly 64 gates are in flight', async () => {
	const ws = fakeWs();
	const gates = [];
	let opened = 0;
	while (hasGateHeadroom(ws)) {
		const d = deferred();
		gates.push(d);
		void withGateCounted(ws, () => d.promise);
		opened++;
		assert.ok(opened <= 200, 'headroom never ran out');
	}
	assert.equal(opened, 64);
	// The bound measures CONCURRENT gates, so finishing one restores headroom.
	gates[0].resolve();
	await gates[0].promise;
	assert.equal(hasGateHeadroom(ws), true);
	for (const d of gates) d.resolve();
	await Promise.all(gates.map((d) => d.promise));
	assert.equal(hasGateHeadroom(ws), true);
});

test('a gate is counted for the whole time it is suspended, not just while it is called', async () => {
	const ws = fakeWs();
	const d = deferred();
	// The distinction that makes the bound mean anything: a hook that awaits a
	// database round-trip returns to the caller immediately, so counting only
	// the synchronous call would bound nothing.
	const running = withGateCounted(ws, () => d.promise);
	let held = 0;
	while (hasGateHeadroom(ws)) {
		held++;
		void withGateCounted(ws, () => new Promise(() => {}));
		if (held > 200) break;
	}
	// 63 more, because the suspended one still occupies a slot.
	assert.equal(held, 63);
	d.resolve();
	await running;
});

test('a gate that throws still releases its slot', async () => {
	const ws = fakeWs();
	const d = deferred();
	const running = withGateCounted(ws, () => d.promise);
	d.reject(new Error('the app hook threw'));
	await assert.rejects(running, /the app hook threw/);
	// A leaked slot is permanent: the connection would answer RATE_LIMITED for
	// the rest of its life after 64 failed gates.
	assert.equal(hasGateHeadroom(ws), true);
});

test('a closed socket has no headroom but still runs the call', async () => {
	const ws = closedWs();
	// Nothing to charge the gate to, so the answer is the conservative one.
	assert.equal(hasGateHeadroom(ws), false);
	// The call still has to happen: the caller needs a verdict, not a crash.
	assert.equal(await withGateCounted(ws, async () => 'verdict'), 'verdict');
});

test('unsubscribe hooks are bounded PER CONNECTION and do not touch the gate counter', () => {
	// The two lanes are separate counters on purpose. Sharing one meant an
	// ordinary page unmounting a hundred stores drove the shared count past the
	// gate bound, and the SUBSCRIBE path then answered RATE_LIMITED on a
	// connection nowhere near any real limit - a SvelteKit route change, which
	// unmounts the old stores and mounts the new ones in one tick, hit exactly
	// that.
	const ws = fakeWs();
	const held = [];
	for (let i = 0; i < 200; i++) {
		held.push(deferred());
		runUnsubscribeHook(ws, () => held[i].promise, true);
	}
	assert.equal(hasGateHeadroom(ws), true, 'teardown must not starve the subscribe lane');
});

test('a connection cannot burst more concurrent unsubscribe hooks than the bound', () => {
	// Bun does not await the message handler, so a client holding the permitted
	// subscriptions can pipeline every release in one read burst and land them
	// all synchronously. The held lane used to skip the headroom test entirely.
	const ws = fakeWs();
	let concurrent = 0;
	let peak = 0;
	const gates = [];
	for (let i = 0; i < 5000; i++) {
		const d = deferred();
		gates.push(d);
		runUnsubscribeHook(
			ws,
			() => {
				concurrent++;
				if (concurrent > peak) peak = concurrent;
				return d.promise;
			},
			true
		);
	}
	assert.equal(peak, 64, 'the default bound is what actually bounds it');
});

test('a required hook is deferred, never refused, while there is queue space', () => {
	const ws = fakeWs();
	for (let i = 0; i < 64; i++) runUnsubscribeHook(ws, () => deferred().promise, true);
	// Speculative work yields once the slots are full...
	assert.equal(runUnsubscribeHook(ws, () => Promise.resolve(), false), 'refused');
	// ...but a real release waits instead of being dropped: dropping it leaks
	// the plugin state the app releases in that hook, silently, because the
	// family client sends unsubscribe with no ref and has no refusal branch.
	assert.equal(runUnsubscribeHook(ws, () => Promise.resolve(), true), 'queued');
});

test('a closed socket refuses the hook rather than throwing', () => {
	assert.equal(runUnsubscribeHook(closedWs(), () => Promise.resolve(), true), 'refused');
});

test('clearing a connection stops its queued hooks from resuming', async () => {
	const ws = fakeWs();
	const first = deferred();
	let queuedRan = false;
	for (let i = 0; i < 64; i++) runUnsubscribeHook(ws, () => (i === 0 ? first.promise : deferred().promise), true);
	runUnsubscribeHook(ws, () => {
		queuedRan = true;
		return Promise.resolve();
	}, true);
	clearUnsubscribeHooks(ws.getUserData());
	first.resolve();
	await first.promise;
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(queuedRan, false, 'the close hook does this teardown; the socket is gone');
});

test('a release whose hook never finished is handed to the close hook', async () => {
	// The release runs BEFORE the hook is queued and deletes the topic from the
	// subscription set, which is what the close hook is handed. So a hook still
	// waiting when the connection dies is dropped by clearUnsubscribeHooks AND
	// absent from the snapshot, and the app's per-topic state is released by
	// nobody. This record is what closes that gap.
	const ws = fakeWs();
	const ud = ws.getUserData();
	assert.deepEqual([...pendingReleaseTopics(ud)], []);

	beginPendingRelease(ud, 'room:1');
	beginPendingRelease(ud, 'room:2');
	assert.deepEqual([...pendingReleaseTopics(ud)].sort(), ['room:1', 'room:2']);

	// A hook that finishes tears its own topic down, so the close hook must not
	// be told to do it again.
	endPendingRelease(ud, 'room:1');
	assert.deepEqual([...pendingReleaseTopics(ud)], ['room:2']);

	// The record is dropped once the close hook has been handed it.
	clearPendingReleases(ud);
	assert.deepEqual([...pendingReleaseTopics(ud)], []);
});

test('the pending-release record tolerates a connection that never had one', () => {
	// The close path reads it unconditionally, including for connections that
	// never sent an unsubscribe frame at all.
	assert.deepEqual([...pendingReleaseTopics({})], []);
	assert.deepEqual([...pendingReleaseTopics(undefined)], []);
	endPendingRelease(undefined, 'room:1');
	clearPendingReleases(undefined);
});

test('an overflowing queue leaves every dropped release recorded', async () => {
	// The scenario the bound exists for: a client pipelines more releases than
	// the queue holds. Whatever the queue refuses to carry must still reach the
	// app by the close route, so the count that matters is that NOTHING went
	// missing between the two.
	const ws = fakeWs();
	const ud = ws.getUserData();
	const gate = deferred();
	const outcomes = [];
	for (let i = 0; i < 200; i++) {
		const topic = `room:${i}`;
		beginPendingRelease(ud, topic);
		outcomes.push(
			runUnsubscribeHook(ws, () => gate.promise.finally(() => endPendingRelease(ud, topic)), true)
		);
	}
	// The bound held: only the concurrency limit ran, the rest are waiting.
	const ran = outcomes.filter((o) => o === 'ran').length;
	assert.equal(ran, 64);
	assert.equal(outcomes.filter((o) => o === 'queued').length, 200 - 64);

	// Nothing has finished, so every topic is still owed a teardown.
	assert.equal(pendingReleaseTopics(ud).size, 200);

	// The connection dies with all of them outstanding.
	clearUnsubscribeHooks(ud);
	gate.resolve();
	await new Promise((r) => setTimeout(r, 0));

	// The ones that were RUNNING completed and cleared themselves; the ones the
	// clear dropped are still recorded, which is what puts them in the close
	// hook's snapshot.
	assert.equal(pendingReleaseTopics(ud).size, 200 - 64);
});

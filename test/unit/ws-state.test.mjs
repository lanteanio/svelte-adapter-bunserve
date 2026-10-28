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
	chargeControlEgress,
	wsCounters
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

test('production connection slots share the family registry keys', async () => {
	const slots = await import('../../src/runtime/handler/ws-state.js');
	for (const [name, key] of Object.entries({ WS_STATS: 'stats', WS_COALESCED: 'coalesced', WS_LEASE: 'lease', WS_TOPIC_IDS: 'topic-ids', WS_WIRE_STATE: 'wire-state', WS_SHARED_COHORTS: 'shared-cohorts', WS_CONNECTION_PERMIT: 'connection-permit' })) {
		assert.equal(slots[name], Symbol.for('adapter-uws.ws.' + key), name);
	}
});

test('runtime slots shadow inherited setters and preserve an own connection permit', async () => {
	const { declareRuntimeConnectionSlots, WS_STATS, WS_CONNECTION_PERMIT } = await import('../../src/runtime/handler/ws-state.js');
	let calls = 0;
	const prototype = {};
	Object.defineProperty(prototype, WS_STATS, { set() { calls++; }, get() { throw new Error('inherited stats read'); } });
	Object.defineProperty(prototype, WS_CONNECTION_PERMIT, { set() { calls++; } });
	const userData = Object.create(prototype);
	Object.defineProperty(userData, WS_CONNECTION_PERMIT, { value: true, writable: true, configurable: true });
	declareRuntimeConnectionSlots(userData);
	const stats = { bytes: 1 };
	userData[WS_STATS] = stats;
	assert.equal(calls, 0);
	assert.equal(Object.hasOwn(userData, WS_STATS), true);
	assert.equal(userData[WS_STATS], stats);
	assert.equal(userData[WS_CONNECTION_PERMIT], true);
});

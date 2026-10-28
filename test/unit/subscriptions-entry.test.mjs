import { test } from 'node:test';
import assert from 'node:assert/strict';

// The `./subscriptions` entry, imported by package name the way a plugin in
// another package imports it - and with none of the globals a build injects
// into the runtime. Loading it must not reach the runtime's configuration,
// which reads those globals at module load and would throw here.
import * as entry from 'svelte-adapter-bunserve/subscriptions';

test('the entry exports tracked membership and rollback helpers and nothing else', () => {
	assert.deepEqual(Object.keys(entry).sort(), ['releaseSubscription', 'trackedSubscribe', 'trackedUnsubscribe']);
	assert.equal(typeof entry.releaseSubscription, 'function');
	assert.equal(typeof entry.trackedSubscribe, 'function');
	assert.equal(typeof entry.trackedUnsubscribe, 'function');
});

test('it loads without the globals a build provides', () => {
	for (const name of ['ENV_PREFIX', 'WS_OPTIONS', 'WS_PATH']) {
		assert.equal(name in globalThis, false, `${name} is not set in this process`);
	}
});

test('it moves membership on the registered slots', () => {
	const subscriptions = new Set();
	const native = new Set();
	const ws = {
		getUserData: () => ({ [Symbol.for('adapter-uws.ws.subscriptions')]: subscriptions }),
		subscribe: (/** @type {string} */ topic) => native.add(topic),
		unsubscribe: (/** @type {string} */ topic) => native.delete(topic)
	};
	assert.equal(entry.trackedSubscribe(ws, 'room'), true);
	assert.deepEqual([...subscriptions], ['room']);
	assert.deepEqual([...native], ['room']);
	assert.equal(entry.trackedUnsubscribe(ws, 'room'), true);
	assert.equal(subscriptions.size, 0);
	assert.equal(native.size, 0);
});

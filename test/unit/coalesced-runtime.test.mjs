import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setRuntimeEnv, resetRuntimeEnv } from '../../src/runtime/runtime.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { platform } = await import('../../src/runtime/handler/platform.js');
const { flushCoalescedFor } = await import('../../src/runtime/handler/coalesced.js');
const { setOperationalEventSink } = await import('../../src/runtime/diagnostic.js');
const { WS_COALESCED, WS_PLATFORM, wsConnections } = await import('../../src/runtime/handler/ws-state.js');

function socket(status = 1) {
	return {
		ud: {}, sent: [], status,
		getUserData() { return this.ud; },
		send(payload) {
			if (this.status !== 2) this.sent.push(JSON.parse(payload));
			return this.status;
		}
	};
}
function send(ws, key, data, event = 'value') {
	platform.sendCoalesced(ws, { key, topic: 'room', event, data });
}

test('arbitrary thrown values become TypeErrors without inspecting thrown proxies', () => {
	let traps = 0;
	const hostile = new Proxy({}, {
		get() { traps++; throw new Error('get trap'); },
		getPrototypeOf() { traps++; throw new Error('prototype trap'); }
	});
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const thrown of ['valid-looking text', null, undefined, false, 42, Symbol('failure'), hostile, revoked.proxy]) {
		const ws = socket();
		assert.throws(() => send(ws, 'bad', { toJSON() { throw thrown; } }), {
			name: 'TypeError', message: 'sendCoalesced data has no JSON form'
		});
		assert.equal(ws.sent.length, 0);
		assert.equal(ws.ud[WS_COALESCED].size, 0);
	}
	assert.equal(traps, 0);
});

test('immediate native errors retain identity, including another realm', () => {
	for (const failure of [new Error('native'), new TypeError('native type'), runInNewContext('new Error("other realm")')]) {
		assert.throws(() => send(socket(), 'bad', { toJSON() { throw failure; } }), (err) => err === failure);
	}
});

test('queued failures cannot escape a drain even when the reporter throws', () => {
	const ws = socket(2);
	send(ws, 'barrier', 0);
	for (const [i, value] of [undefined, null, 'text', false, 42, new Error('native')].entries()) {
		send(ws, i, { toJSON() { throw value; } });
	}
	send(ws, 'good', 7);
	const reports = [];
	ws.ud[WS_PLATFORM] = { requestId: 'request-123' };
	setOperationalEventSink(event => {
		reports.push(event);
		throw new Error('reporter failed');
	});
	try {
		ws.status = 1;
		assert.doesNotThrow(() => flushCoalescedFor(ws));
	} finally { setOperationalEventSink(null); }
	assert.equal(reports.length, 6);
	for (const event of reports) {
		assert.equal(event.event, 'ws.send-coalesced.unserializable');
		assert.equal(event.attributes.requestId, 'request-123');
		assert.equal(event.source, 'svelte-adapter-bunserve');
		assert.equal(event.attributes.errorId, 'ADAPTER-ERR-COALESCED-UNSERIALIZABLE');
		assert.deepEqual(event.attributes.key, { dataClass: 'pseudonymous', kind: 'coalesced-key', valueType: 'number' });
		for (const [field, kind, value] of [['topic', 'topic', 'room'], ['event', 'event', 'value']]) {
			const metadata = event.attributes[field];
			assert.equal(metadata.dataClass, 'pseudonymous');
			assert.equal(metadata.kind, kind);
			assert.match(metadata.ref, new RegExp('^' + kind + ':[A-Za-z0-9_-]{16}$'));
			assert.equal(Object.values(metadata).includes(value), false);
		}
	}
	assert.deepEqual(ws.sent.map((msg) => msg.data), [0, 7]);
	assert.equal(ws.ud[WS_COALESCED].size, 0);
});

for (const fail of [false, true]) {
	test(`a same-key serializer replacement is the only value sent (throw=${fail})`, () => {
		const ws = socket();
		let calls = 0;
		send(ws, 'key', { toJSON() {
			calls++;
			send(ws, 'key', 2, 'latest');
			if (fail) throw new Error('superseded failure');
			return 1;
		} }, 'older');
		assert.equal(calls, 1);
		assert.deepEqual(ws.sent, [{ topic: 'room', event: 'latest', data: 2 }]);
		assert.equal(ws.ud[WS_COALESCED].size, 0);
	});
}

test('a different-key serializer enqueue preserves insertion order without recursive serialization', () => {
	const ws = socket();
	let serializing = false;
	send(ws, 'first', { toJSON() {
		assert.equal(serializing, false);
		serializing = true;
		send(ws, 'second', { toJSON() { assert.equal(serializing, false); return 2; } });
		serializing = false;
		return 1;
	} });
	assert.deepEqual(ws.sent.map((msg) => msg.data), [1, 2]);
});

test('invalid envelope names cannot replace a pending value', () => {
	const ws = socket(2);
	send(ws, 'key', 'original');
	const entry = ws.ud[WS_COALESCED].get('key');
	for (const field of ['topic', 'event']) {
		for (const invalid of ['quote"', 'slash\\', 'line\n']) {
			assert.throws(() => platform.sendCoalesced(ws, {
				key: 'key', topic: 'room', event: 'value', data: 'replacement', [field]: invalid
			}), /contains invalid character/);
			assert.equal(ws.ud[WS_COALESCED].get('key'), entry);
		}
	}
	ws.status = 1;
	flushCoalescedFor(ws);
	assert.equal(ws.sent[0].data, 'original');
});

test('serialization uses the envelope prefix validated before the entry was queued', () => {
	const ws = socket(2);
	send(ws, 'barrier', 0);
	send(ws, 'key', { toJSON() {
		ws.ud[WS_COALESCED].get('key').topic = 'later"';
		return 1;
	} });
	ws.status = 1;
	flushCoalescedFor(ws);
	assert.deepEqual(ws.sent[1], { topic: 'room', event: 'value', data: 1 });
});

for (const sameKey of [true, false]) {
	test(`repeated ${sameKey ? 'same' : 'new'}-key serializers yield and resume on the runtime timer`, () => {
		const timers = [];
		setRuntimeEnv({ timers: { set(cb, ms) { assert.equal(ms, 0); timers.push(cb); return cb; } } });
		const ws = socket();
		wsConnections.add(ws);
		let calls = 0;
		const value = { toJSON() {
			calls++;
			if (calls < 6) send(ws, sameKey ? 'key' : calls, value);
			return calls;
		} };
		try {
			send(ws, 'key', value);
			assert.equal(calls, 2, 'the initial pass is bounded');
			assert.equal(timers.length, 1, 'only one continuation is scheduled');
			timers.shift()();
			assert.equal(calls, 4);
			assert.equal(timers.length, 1);
			timers.shift()();
			assert.equal(calls, 6);
			assert.equal(timers.length, 0);
			assert.equal(ws.ud[WS_COALESCED].size, 0);
			assert.deepEqual(ws.sent.map((msg) => msg.data), sameKey ? [6] : [1, 2, 3, 4, 5, 6]);
		} finally { wsConnections.delete(ws); resetRuntimeEnv(); }
	});
}

test('a scheduled continuation drops its queue after close without calling another serializer', () => {
	const timers = [];
	setRuntimeEnv({ timers: { set(cb) { timers.push(cb); return cb; } } });
	const ws = socket();
	wsConnections.add(ws);
	let calls = 0;
	const value = { toJSON() { calls++; send(ws, 'key', value); return 1; } };
	try {
		send(ws, 'key', value);
		assert.equal(calls, 2);
		wsConnections.delete(ws);
		timers.shift()();
		assert.equal(calls, 2);
		assert.equal(ws.ud[WS_COALESCED].size, 0);
		assert.equal(timers.length, 0);
	} finally { wsConnections.delete(ws); resetRuntimeEnv(); }
});

test('two yielding flushes in one turn share one continuation', () => {
	const timers = [];
	setRuntimeEnv({ timers: { set(cb) { timers.push(cb); return cb; } } });
	const ws = socket();
	wsConnections.add(ws);
	let calls = 0;
	const value = { toJSON() { calls++; send(ws, 'key', value); return 1; } };
	try {
		send(ws, 'key', value);
		flushCoalescedFor(ws);
		assert.equal(calls, 4);
		assert.equal(timers.length, 1);
		wsConnections.delete(ws);
		timers.shift()();
		assert.equal(ws.ud[WS_COALESCED].size, 0);
	} finally { wsConnections.delete(ws); resetRuntimeEnv(); }
});


test('an undefined oldest key is evicted at the pending entry cap', () => {
	const ws = socket(2);
	send(ws, undefined, 0);
	const pending = ws.ud[WS_COALESCED];
	// Fill the documented capacity without repeatedly attempting the wire.
	const entry = pending.get(undefined);
	for (let i = 0; i < 999_999; i++) pending.set(i, entry);
	assert.equal(pending.size, 1_000_000);
	send(ws, 'newest', 1);
	assert.equal(pending.size, 1_000_000);
	assert.equal(pending.has(undefined), false);
	assert.equal(pending.has(0), true);
	assert.equal(pending.get('newest').data, 1);
	pending.clear();
});

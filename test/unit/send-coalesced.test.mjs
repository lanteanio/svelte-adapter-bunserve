import { test } from 'node:test';
import assert from 'node:assert/strict';

// platform.sendCoalesced: one pending value per (connection, key), latest
// wins, flushed at once and again on every drain - and a value JSON cannot
// carry costs the caller a throw when it flushes at once, or a log line when
// it flushes later from a drain, never the worker.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { platform } = await import('../../src/runtime/handler/platform.js');
const { flushCoalescedFor } = await import('../../src/runtime/handler/coalesced.js');
const { drainCoalesced } = await import('../../src/runtime/utils/backpressure.js');
const { parseDiagnostic } = await import('../../src/runtime/diagnostic.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { WS_COALESCED, wsConnections, wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { SEND_BACKPRESSURE, SEND_DROPPED, SEND_SUCCESS } = await import('../../src/runtime/utils/send-result.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

/** A facade whose send answers from a script, then with `fallback`. */
function fakeWs(script = [], fallback = SEND_SUCCESS) {
	const ud = {};
	return {
		ud,
		sent: [],
		getUserData: () => ud,
		send(payload) {
			this.sent.push(JSON.parse(payload));
			return script.length ? script.shift() : fallback;
		}
	};
}

const data = (ws) => ws.sent.map((m) => m.data);

test('drainCoalesced: sent continues, queued removes and stops, dropped keeps and stops', () => {
	const pending = new Map([['a', 1], ['b', 2], ['c', 3]]);
	const seen = [];
	drainCoalesced(pending, (v) => { seen.push(v); return v === 2 ? SEND_DROPPED : SEND_SUCCESS; });
	assert.deepEqual(seen, [1, 2]);
	assert.deepEqual([...pending.keys()], ['b', 'c']);
	drainCoalesced(pending, () => SEND_BACKPRESSURE);
	assert.deepEqual([...pending.keys()], ['c'], 'queued counts as sent, and stops the pump');
});

test('the latest value for a key wins, and only it goes out once the socket takes it', () => {
	const ws = fakeWs([SEND_DROPPED, SEND_DROPPED]);
	platform.sendCoalesced(ws, { key: 'cursor', topic: 't', event: 'moved', data: 1 });
	platform.sendCoalesced(ws, { key: 'cursor', topic: 't', event: 'moved', data: 2 });
	platform.sendCoalesced(ws, { key: 'cursor', topic: 't', event: 'moved', data: 3 });
	assert.deepEqual(data(ws), [1, 2, 3], 'each call tried the wire');
	assert.equal(ws.ud[WS_COALESCED].size, 0, 'the third was taken');
	assert.deepEqual(ws.sent.at(-1), { topic: 't', event: 'moved', data: 3 });
});

test('pending keys flush in first-insertion order, each with its latest value', () => {
	// Everything is dropped while the socket is full...
	const ws = fakeWs([], SEND_DROPPED);
	platform.sendCoalesced(ws, { key: 'a', topic: 't', event: 'e', data: 'a1' });
	platform.sendCoalesced(ws, { key: 'b', topic: 't', event: 'e', data: 'b1' });
	platform.sendCoalesced(ws, { key: 'a', topic: 't', event: 'e', data: 'a2' });
	assert.deepEqual([...ws.ud[WS_COALESCED].keys()], ['a', 'b']);
	// ...then the drain finds room.
	ws.sent.length = 0;
	ws.send = function (payload) {
		this.sent.push(JSON.parse(payload));
		return SEND_SUCCESS;
	};
	flushCoalescedFor(ws);
	assert.deepEqual(data(ws), ['a2', 'b1']);
	assert.equal(ws.ud[WS_COALESCED].size, 0);
});

test('a value JSON cannot carry throws to the caller that set it, and the queue still drains', () => {
	const ws = fakeWs();
	assert.throws(() => platform.sendCoalesced(ws, { key: 'k', topic: 't', event: 'e', data: 10n }), TypeError);
	assert.equal(ws.ud[WS_COALESCED].size, 0, 'the entry is gone, not stuck');
	platform.sendCoalesced(ws, { key: 'k', topic: 't', event: 'e', data: 'fine' });
	assert.deepEqual(data(ws), ['fine']);
});

test('one queued behind backpressure and met by a drain is dropped and reported, not thrown', () => {
	const ws = fakeWs([], SEND_DROPPED);
	platform.sendCoalesced(ws, { key: 'good', topic: 't', event: 'e', data: 'before' });
	// The socket is full, so this never reaches the flush inside the call.
	platform.sendCoalesced(ws, { key: 'bad', topic: 't', event: 'e', data: 10n });
	platform.sendCoalesced(ws, { key: 'after', topic: 't', event: 'e', data: 'after' });
	ws.sent.length = 0;
	ws.send = function (payload) {
		this.sent.push(JSON.parse(payload));
		return SEND_SUCCESS;
	};
	const lines = [];
	const real = console.error;
	console.error = (...args) => lines.push(args);
	try {
		assert.doesNotThrow(() => flushCoalescedFor(ws));
	} finally {
		console.error = real;
	}
	assert.deepEqual(data(ws), ['before', 'after']);
	assert.equal(lines.length, 1);
	const parsed = parseDiagnostic(lines[0][0]);
	assert.equal(parsed.format, 'canonical');
	const report = parsed.record;
	assert.equal(report.event, 'ws.send-coalesced.unserializable');
	assert.equal(report.source, 'svelte-adapter-bunserve');
	assert.equal(report.severity, 'error');
	assert.equal(report.attributes.errorId, 'ADAPTER-ERR-COALESCED-UNSERIALIZABLE');
	assert.equal(ws.ud[WS_COALESCED].size, 0);
});

test('a topic or event the envelope cannot carry throws at once, and nothing is queued', () => {
	const ws = fakeWs([], SEND_DROPPED);
	assert.throws(() => platform.sendCoalesced(ws, { key: 'k', topic: 'bad"topic', event: 'e', data: 1 }));
	assert.throws(() => platform.sendCoalesced(ws, { key: 'k', topic: 't', event: 'bad\nevent', data: 1 }));
	assert.equal(ws.ud[WS_COALESCED], undefined);
	assert.deepEqual(ws.sent, []);
});

test('a closed socket is counted in the closed lane and nothing throws', () => {
	const before = wsCounters.closedWsAborts;
	const ws = { getUserData() { throw new Error('closed'); } };
	assert.doesNotThrow(() => platform.sendCoalesced(ws, { key: 'k', topic: 't', event: 'e', data: 1 }));
	assert.equal(wsCounters.closedWsAborts, before + 1);
});

test('a socket that closes mid-flush drops the rest of its queue', () => {
	const ws = fakeWs([], SEND_DROPPED);
	platform.sendCoalesced(ws, { key: 'a', topic: 't', event: 'e', data: 1 });
	platform.sendCoalesced(ws, { key: 'b', topic: 't', event: 'e', data: 2 });
	ws.send = () => { throw new Error('closed'); };
	const before = wsCounters.closedWsAborts;
	flushCoalescedFor(ws);
	assert.equal(ws.ud[WS_COALESCED].size, 0);
	assert.equal(wsCounters.closedWsAborts, before + 1);
});

test('the drain handler flushes the queue before the app\'s drain hook runs', () => {
	const order = [];
	__setHooks({ drain: () => order.push('hook') });
	const raw = {
		data: upgradeData(),
		readyState: 1,
		send(payload) {
			if (raw.full) return 0;
			const msg = JSON.parse(payload);
			if (msg.topic === 't') order.push(`sent ${msg.data}`);
			return payload.length;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => (raw.full ? 1 << 30 : 0),
		cork: (fn) => fn(),
		full: false
	};
	try {
		websocketHandlers.open(raw);
		raw.full = true;
		// A full socket: Bun answers 0 with a backlog, the facade reads DROPPED.
		platform.sendCoalesced([...wsConnections].at(-1), { key: 'k', topic: 't', event: 'e', data: 'held' });
		assert.deepEqual(order, []);
		raw.full = false;
		websocketHandlers.drain(raw);
		assert.deepEqual(order, ['sent held', 'hook']);
	} finally {
		__setHooks({});
		wsConnections.clear();
	}
});

test('a new key at the cap evicts the oldest pending one; an existing key replaces in place', async () => {
	const { MAX_COALESCED_KEYS_PER_CONNECTION } = await import('../../src/runtime/handler/ws-state.js');
	const ws = fakeWs([], SEND_DROPPED);
	// Filled directly: a million calls through the whole sendCoalesced path
	// would cost the suite seconds for nothing the cap check needs.
	const pending = new Map();
	for (let i = 0; i < MAX_COALESCED_KEYS_PER_CONNECTION; i++) pending.set(i, { topic: 't', event: 'e', data: i, prefix: '{"topic":"t","event":"e","data":' });
	ws.ud[WS_COALESCED] = pending;
	const oldest = pending.get(0);
	for (const key of [0, 'invalid-new']) {
		assert.throws(() => platform.sendCoalesced(ws, { key, topic: 'bad"', event: 'e', data: 'bad' }), /contains invalid character/);
		assert.equal(pending.size, MAX_COALESCED_KEYS_PER_CONNECTION);
		assert.equal(pending.get(0), oldest, 'validation precedes both replacement and eviction');
		assert.equal(pending.has('invalid-new'), false);
	}
	platform.sendCoalesced(ws, { key: 'new', topic: 't', event: 'e', data: 'n' });
	assert.equal(pending.size, MAX_COALESCED_KEYS_PER_CONNECTION);
	assert.equal(pending.has(0), false, 'the oldest went');
	assert.equal(pending.has('new'), true);
	platform.sendCoalesced(ws, { key: 5, topic: 't', event: 'e', data: 'five again' });
	assert.equal(pending.size, MAX_COALESCED_KEYS_PER_CONNECTION, 'a key already pending evicts nothing');
	assert.equal(pending.has(1), true);
	assert.equal(pending.get(5).data, 'five again');
});

test('the drain flush runs with no drain hook exported, the common case', () => {
	__setHooks({});
	const sent = [];
	const raw = {
		data: upgradeData(),
		readyState: 1,
		full: false,
		send(payload) {
			if (raw.full) return 0;
			const msg = JSON.parse(payload);
			if (msg.topic === 't') sent.push(msg.data);
			return payload.length;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => (raw.full ? 1 << 30 : 0),
		cork: (fn) => fn()
	};
	try {
		websocketHandlers.open(raw);
		raw.full = true;
		platform.sendCoalesced([...wsConnections].at(-1), { key: 'k', topic: 't', event: 'e', data: 'held' });
		raw.full = false;
		websocketHandlers.drain(raw);
		assert.deepEqual(sent, ['held']);
	} finally {
		wsConnections.clear();
	}
});

test('a bad value queued earlier and met by a later good call is reported, not thrown at that caller', () => {
	const ws = fakeWs([], SEND_DROPPED);
	// A dropped value ahead of it stops each flush before the bad one is ever
	// serialized, so it sits in the queue.
	platform.sendCoalesced(ws, { key: 'first', topic: 't', event: 'e', data: 'first' });
	platform.sendCoalesced(ws, { key: 'bad', topic: 't', event: 'e', data: 10n });
	ws.send = function (payload) {
		this.sent.push(JSON.parse(payload));
		return SEND_SUCCESS;
	};
	const lines = [];
	const real = console.error;
	console.error = (...args) => lines.push(args);
	try {
		assert.doesNotThrow(() => platform.sendCoalesced(ws, { key: 'good', topic: 't', event: 'e', data: 'ok' }));
	} finally {
		console.error = real;
	}
	assert.equal(lines.length, 1, 'the earlier value is reported');
	assert.deepEqual(ws.sent.at(-1).data, 'ok');
});

test('a function value fails with the family wording', () => {
	const ws = fakeWs();
	assert.throws(
		() => platform.sendCoalesced(ws, { key: 'k', topic: 't', event: 'e', data: () => {} }),
		{ name: 'TypeError', message: 'sendCoalesced data has no JSON form' }
	);
});

test('a closing connection releases what it still had queued', () => {
	__setHooks({});
	const raw = {
		data: upgradeData(),
		readyState: 1,
		send: () => 0,
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => 1 << 30,
		cork: (fn) => fn()
	};
	try {
		websocketHandlers.open(raw);
		platform.sendCoalesced([...wsConnections].at(-1), { key: 'k', topic: 't', event: 'e', data: 'never sent' });
		assert.equal(raw.data[WS_COALESCED].size, 1);
		websocketHandlers.close(raw, 1006, '');
		assert.equal(raw.data[WS_COALESCED], undefined);
	} finally {
		wsConnections.clear();
	}
});

test('a detached socket ignores names that an open socket would reject', () => {
	const before = wsCounters.closedWsAborts;
	const ws = { getUserData() { throw new Error('closed'); } };
	assert.doesNotThrow(() => platform.sendCoalesced(ws, { key: 'k', topic: 'bad"topic', event: 'e' }));
	assert.equal(wsCounters.closedWsAborts, before + 1);
});

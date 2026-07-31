import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsFacade, WsClosedError } from '../../src/runtime/handler/ws-facade.js';

/**
 * A stand-in for Bun's ServerWebSocket that reproduces the probed
 * closed-socket behavior: nothing throws, subscribe reports success, send
 * reports 0, getBufferedAmount reports 0.
 */
function fakeSocket(overrides = {}) {
	const calls = [];
	const topics = new Set();
	return {
		data: { user: 'u1' },
		readyState: 1,
		calls,
		send(payload, compress) {
			calls.push(['send', payload, compress]);
			return this.readyState === 1 ? String(payload).length : 0;
		},
		publish(topic, payload, compress) {
			calls.push(['publish', topic, payload, compress]);
			return this.readyState === 1 ? String(payload).length : 0;
		},
		subscribe(topic) {
			calls.push(['subscribe', topic]);
			topics.add(topic);
			return true; // Bun returns true even when closed - the probed trap.
		},
		unsubscribe(topic) {
			calls.push(['unsubscribe', topic]);
			topics.delete(topic);
			return true;
		},
		isSubscribed(topic) {
			return this.readyState === 1 && topics.has(topic);
		},
		getBufferedAmount() {
			return 0;
		},
		close(code, reason) {
			calls.push(['close', code, reason]);
			this.readyState = 3;
		},
		terminate() {
			calls.push(['terminate']);
			this.readyState = 3;
		},
		...overrides
	};
}

test('one facade per socket, stable across lookups', () => {
	// Identity backs the live-connection Set and the excludeWs comparison.
	const raw = fakeSocket();
	assert.equal(wsFacade(raw), wsFacade(raw));
	assert.notEqual(wsFacade(raw), wsFacade(fakeSocket()));
});

test('getUserData returns the upgrade-time data object', () => {
	const raw = fakeSocket();
	assert.equal(wsFacade(raw).getUserData(), raw.data);
});

test('send maps Bun byte counts onto the uWS tri-state', () => {
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	assert.equal(ws.send('hello'), 1);           // 5 bytes accepted -> success
	raw.send = () => -1;
	assert.equal(ws.send('hello'), 0);           // backpressure -> enqueued
	raw.send = () => 0;
	assert.equal(ws.send('hello'), 2);           // rejected -> dropped
});

test('send on a CLOSED socket throws instead of reporting a backpressure drop', () => {
	// The ordering contract. Bun would return 0 here, which maps to DROPPED
	// (2) - the sentinel that poisons this connection's wire state. A closed
	// socket must take the closed lane instead, where nothing is poisoned.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	raw.readyState = 3;
	assert.throws(() => ws.send('late'), WsClosedError);
	assert.throws(() => ws.send('late'), /WS_CLOSED|closed/);
});

test('the closed check runs BEFORE the socket is touched', () => {
	// Not just "before mapping" - a closed send must not reach the transport
	// at all, or a mapped result could still be produced from its return value.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	raw.readyState = 3;
	const before = raw.calls.length;
	assert.throws(() => ws.send('late'));
	assert.equal(raw.calls.length, before, 'raw.send was never called');
});

test('subscribe throws on a closed socket even though Bun returns true', () => {
	// The silent-success trap: without this the extensions' try/catch never
	// fires and a failed attach reports success.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	assert.equal(ws.subscribe('room'), true);
	raw.readyState = 3;
	assert.equal(raw.subscribe('room'), true, 'the raw socket still lies');
	assert.throws(() => ws.subscribe('room'), WsClosedError);
});

test('the thrown error carries a matchable code and the operation name', () => {
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	raw.readyState = 3;
	try {
		ws.subscribe('room');
		assert.fail('should have thrown');
	} catch (err) {
		assert.equal(err.name, 'WsClosedError');
		assert.equal(err.code, 'WS_CLOSED');
		assert.equal(err.operation, 'subscribe');
	}
});

test('unsubscribe and getBufferedAmount throw on a closed socket', () => {
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	raw.readyState = 3;
	assert.throws(() => ws.unsubscribe('room'), WsClosedError);
	assert.throws(() => ws.getBufferedAmount(), WsClosedError);
});

test('isSubscribed answers false on a closed socket rather than throwing', () => {
	// A closed socket is subscribed to nothing; that is an answer, not an error.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	ws.subscribe('room');
	assert.equal(ws.isSubscribed('room'), true);
	raw.readyState = 3;
	assert.doesNotThrow(() => ws.isSubscribed('room'));
	assert.equal(ws.isSubscribed('room'), false);
});

test('_markClosed shuts the facade before Bun updates readyState', () => {
	// The close handler marks the facade first, so a user close hook that
	// reaches for the socket gets the throw rather than a silent no-op against
	// a socket Bun still reports as open.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	ws._markClosed();
	assert.equal(raw.readyState, 1, 'Bun still reports open');
	assert.throws(() => ws.send('x'), WsClosedError);
	assert.throws(() => ws.subscribe('t'), WsClosedError);
	assert.equal(ws.isSubscribed('t'), false);
});

test('end() closes gracefully with code and reason; close() cuts hard', () => {
	// uWS spelling: end = graceful, close = hard. Bun spells those close and
	// terminate, so the names cross over. Backwards here turns every graceful
	// close into a 1006 at the client.
	const graceful = fakeSocket();
	wsFacade(graceful).end(4001, 'bye');
	assert.deepEqual(graceful.calls, [['close', 4001, 'bye']]);

	const hard = fakeSocket();
	wsFacade(hard).close();
	assert.deepEqual(hard.calls, [['terminate']]);
});

test('closing twice is a no-op rather than an error', () => {
	// Cleanup paths call end() without knowing whether close already fired.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	ws.end(1000, 'first');
	assert.doesNotThrow(() => ws.end(1000, 'second'));
	assert.doesNotThrow(() => ws.close());
	assert.deepEqual(raw.calls, [['close', 1000, 'first']]);
});

test('publish from a socket maps its result and refuses when closed', () => {
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	assert.equal(ws.publish('room', 'hello'), 1);
	raw.readyState = 3;
	assert.throws(() => ws.publish('room', 'hello'), WsClosedError);
});

test('readyState and raw are exposed for code that needs the real socket', () => {
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	assert.equal(ws.readyState, 1);
	assert.equal(ws.raw, raw);
	raw.readyState = 3;
	assert.equal(ws.readyState, 3);
});

test('getUserData still reads while the socket is merely closed', () => {
	// The close HOOK runs in this window and must be able to identify the
	// connection it is tearing down - the extensions registry calls
	// `identify(ws)` unguarded inside its own close hook, and uWS keeps
	// userData valid for the duration of that callback. Throwing here aborted
	// the hook at its first line.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	ws._markClosed();
	raw.readyState = 3;
	assert.deepEqual(ws.getUserData(), { user: 'u1' });
	// Writes are refused in that same window.
	assert.throws(() => ws.send('x'), WsClosedError);
});

test('an empty send on a healthy socket maps to SUCCESS, not DROPPED', () => {
	// Bun returns 0 for send('') on an open socket because zero bytes were
	// accepted, but the frame IS delivered (probed). The facade discriminates
	// via the backlog: nothing buffered means the frame went out.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	raw.send = () => 0;
	assert.equal(ws.send(''), 1);
	assert.equal(ws.send(new Uint8Array(0)), 1);
});

test('an empty send against a backlog stays DROPPED', () => {
	// Past the backpressure limit the empty frame is genuinely dropped
	// (probed: never delivered), and the backlog is what tells the two apart.
	const raw = fakeSocket({ getBufferedAmount: () => 16 * 1024 });
	const ws = wsFacade(raw);
	raw.send = () => 0;
	assert.equal(ws.send(''), 2);
	assert.equal(ws.send(new Uint8Array(0)), 2);
});

test('the empty-send discrimination does not touch non-empty sends', () => {
	// A NON-empty payload returning 0 is the real rejected case regardless of
	// backlog; only zero-length payloads consult getBufferedAmount.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	raw.send = () => 0;
	assert.equal(ws.send('x'), 2);
	// And an empty send that reports backpressure keeps the enqueued meaning.
	raw.send = () => -1;
	assert.equal(ws.send(''), 0);
});

test('getUserData throws once the connection is detached', () => {
	// Consumers build their closed-socket rollback on this throw: the extensions
	// registry catches it to bail BEFORE registering the connection in shared
	// cluster state. A never-throwing read let that code register a dead socket
	// that nothing would ever remove.
	const raw = fakeSocket();
	const ws = wsFacade(raw);
	assert.deepEqual(ws.getUserData(), { user: 'u1' });
	ws._markDetached();
	assert.throws(() => ws.getUserData(), WsClosedError);
	// The adapter's own teardown still reads it.
	assert.deepEqual(ws._rawUserData(), { user: 'u1' });
});

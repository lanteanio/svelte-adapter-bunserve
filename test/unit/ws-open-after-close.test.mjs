import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE WELCOME FRAME CAN CLOSE THE CONNECTION, and what happens next is the
// app's lifecycle contract.
//
// `sendControl` is charged against the control-egress budget, and a budget
// smaller than the welcome frame refuses it and cuts the socket with 4429. That
// close handler runs to completion from inside the open handler - so by the
// line after the send, the connection has been deregistered, its permit
// released, and its close hook already called.
//
// Announcing that connection to the app's `open` hook anyway is wrong in every
// direction: `close` arrives before `open`, and the hook's first
// `ws.getUserData()` throws, which the hook-error reporter then describes as
// "the connection was left open".

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
// The budget is a fixed constant, so the test spends it rather than shrinking
// it: a connection charged its whole window has nothing left for the welcome
// frame, which is the state this exercises.
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js'
};


const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { MAX_CONTROL_EGRESS_BYTES, chargeControlEgress, wsConnections } =
	await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/** The minimum of Bun's ServerWebSocket the open and close paths touch. */
function rawSocket() {
	const raw = {
		data: {},
		readyState: 1,
		sent: [],
		closedWith: null,
		send(payload) { raw.sent.push(payload); return payload.length; },
		close(code, reason) {
			if (raw.readyState !== 1) return;
			raw.readyState = 3;
			raw.closedWith = { code, reason };
			// Bun runs the close handler from inside the close call, which is
			// what puts it inside the open handler here.
			websocketHandlers.close(raw, code, String(reason ?? ''));
		},
		terminate() { raw.close(1006, ''); },
		subscribe() {},
		unsubscribe() {},
		isSubscribed() { return false; },
		getBufferedAmount() { return 0; },
		cork(fn) { return fn(); }
	};
	return raw;
}

test('an open hook is not called for a connection the welcome frame already closed', () => {
	const seen = [];
	const errors = [];
	const realError = console.error;
	console.error = (/** @type {unknown} */ m) => { errors.push(String(m)); };
	__setHooks({
		open: (ws) => {
			// What an app does first, and what used to throw here.
			seen.push(`open:${JSON.stringify(ws.getUserData() ?? null)}`);
		},
		close: () => { seen.push('close'); }
	});
	try {
		const raw = rawSocket();
		// Spend the window before the handler runs, so the welcome frame is the
		// send that finds nothing left.
		// The budget lives on userData, which the runtime reaches through its
		// facade; the stub is the raw socket, so hand the charge the same object.
		chargeControlEgress({ getUserData: () => raw.data }, MAX_CONTROL_EGRESS_BYTES);
		websocketHandlers.open(raw);

		assert.equal(raw.closedWith?.code, 4429, 'the welcome frame was refused and cut the socket');
		assert.deepEqual(seen, ['close'], 'the app saw a close and no open');
		assert.equal(errors.length, 0, 'and no hook-error line claiming the connection was left open');
		assert.equal(wsConnections.size, 0, 'the registry is empty afterwards');
	} finally {
		console.error = realError;
		__setHooks({});
	}
});

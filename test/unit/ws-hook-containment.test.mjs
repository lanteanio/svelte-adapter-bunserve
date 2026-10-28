import { test } from 'node:test';
import assert from 'node:assert/strict';

// The hook boundary as the real handlers use it: an `open` or `message` hook
// that throws closes its own connection with 1011, the `close` hook then runs
// for it as for any other close, and the other connections are untouched.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { wsConnections } = await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

/** Bun's raw socket, whose close() runs the close handler synchronously. */
function rawSocket() {
	const raw = {
		data: upgradeData(),
		sent: [],
		closedWith: null,
		readyState: 1,
		send(payload) {
			raw.sent.push(payload);
			return payload.length;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close(code, reason) {
			if (raw.readyState !== 1) return;
			raw.readyState = 3;
			raw.closedWith = { code, reason };
			websocketHandlers.close(raw, code, reason);
		},
		terminate() {
			raw.close(1006, '');
		},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
	return raw;
}

function quietErrors() {
	const lines = [];
	const real = console.error;
	console.error = (...args) => lines.push(String(args[0]));
	return { lines, restore: () => { console.error = real; } };
}

test('an open hook that throws closes its connection 1011, and the close hook still runs', () => {
	const seen = [];
	__setHooks({
		open: () => {
			throw new Error('open broke');
		},
		close: (ws, ctx) => {
			seen.push(ctx.code);
		}
	});
	const errors = quietErrors();
	try {
		const bystander = rawSocket();
		__setHooks({ close: () => {} });
		websocketHandlers.open(bystander);
		__setHooks({
			open: () => {
				throw new Error('open broke');
			},
			close: (ws, ctx) => {
				seen.push(ctx.code);
			}
		});
		const raw = rawSocket();
		websocketHandlers.open(raw);
		assert.deepEqual(raw.closedWith, { code: 1011, reason: 'Open handler error' });
		assert.deepEqual(seen, [1011], 'the close hook ran for it');
		assert.deepEqual(errors.lines, ['[ws] the open hook threw [ADAPTER-ERR-OPEN-HOOK]']);
		assert.equal(bystander.closedWith, null, 'the other connection is untouched');
		assert.ok(wsConnections.size >= 1);
	} finally {
		errors.restore();
		__setHooks({});
		wsConnections.clear();
	}
});

test('a message hook that throws on a frame closes that connection 1011', async () => {
	__setHooks({
		message: () => {
			throw new Error('message broke');
		}
	});
	const errors = quietErrors();
	try {
		const raw = rawSocket();
		websocketHandlers.open(raw);
		await websocketHandlers.message(raw, 'plain text the app handles');
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.deepEqual(raw.closedWith, { code: 1011, reason: 'Message handler error' });
		assert.deepEqual(errors.lines, ['[ws] the message hook threw [ADAPTER-ERR-MESSAGE-HOOK]']);
	} finally {
		errors.restore();
		__setHooks({});
		wsConnections.clear();
	}
});

test('a drain hook that rejects closes that connection 1011', async () => {
	__setHooks({
		drain: async () => {
			throw new Error('drain broke');
		}
	});
	const errors = quietErrors();
	try {
		const raw = rawSocket();
		websocketHandlers.open(raw);
		websocketHandlers.drain(raw);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.deepEqual(raw.closedWith, { code: 1011, reason: 'Drain handler error' });
		assert.deepEqual(errors.lines, ['[ws] the drain hook threw [ADAPTER-ERR-DRAIN-HOOK]']);
	} finally {
		errors.restore();
		__setHooks({});
		wsConnections.clear();
	}
});

test('a close this side sent with no status reads 0 to the close hook; a peer\'s 1005 stays 1005', async () => {
	const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
	const codes = [];
	__setHooks({ close: (ws, ctx) => codes.push(ctx.code) });
	try {
		const ours = rawSocket();
		websocketHandlers.open(ours);
		wsFacade(ours).end();
		assert.deepEqual(ours.closedWith, { code: 1005, reason: undefined }, 'an empty close frame went out');

		const theirs = rawSocket();
		websocketHandlers.open(theirs);
		// The peer closed with an empty close frame: Bun reports 1005.
		websocketHandlers.close(theirs, 1005, '');

		assert.deepEqual(codes, [0, 1005]);
	} finally {
		__setHooks({});
		wsConnections.clear();
	}
});

test('a falsy open or drain export is skipped, as a hook that is switched off', async () => {
	// `export const open = dev && fn` reads false in production.
	__setHooks({ open: false, drain: 0 });
	const errors = quietErrors();
	try {
		const raw = rawSocket();
		websocketHandlers.open(raw);
		websocketHandlers.drain(raw);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.equal(raw.closedWith, null, 'the connection is still open');
		assert.deepEqual(errors.lines, []);
	} finally {
		errors.restore();
		__setHooks({});
		wsConnections.clear();
	}
});

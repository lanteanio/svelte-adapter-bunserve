import { test } from 'node:test';
import assert from 'node:assert/strict';

// The shutdown drain: every live connection is advised first, then every one
// is closed with 1001 "Server shutting down", as on svelte-adapter-uws. The
// live lane cannot pin the code - Bun's own client reports a 1001 as 1000 -
// so it is read here off the call the facade receives.
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = { allowedOrigins: 'any', path: '/ws', handler: 'src/ws-handler.js' };

const { drainWebSockets } = await import('../../src/runtime/handler/ws-drain.js');
const { WS_PLATFORM, WS_SUBSCRIPTIONS, wsConnections } = await import('../../src/runtime/handler/ws-state.js');

/** A live facade whose end() runs the close handler's deregistration inline, as Bun does. */
function liveSocket(log, id) {
	const ud = { [WS_PLATFORM]: {}, [WS_SUBSCRIPTIONS]: new Set() };
	const ws = {
		getUserData: () => ud,
		send(payload) {
			log.push(['send', id, JSON.parse(payload).type]);
			return 1;
		},
		end(code, reason) {
			log.push(['end', id, code, reason]);
			wsConnections.delete(ws);
		}
	};
	wsConnections.add(ws);
	return ws;
}

async function quietly(fn) {
	const real = console.log;
	console.log = () => {};
	try {
		await fn();
	} finally {
		console.log = real;
	}
}

test('with the advisory on, every connection is advised before any is closed, then all close 1001', async () => {
	const log = [];
	liveSocket(log, 'a');
	liveSocket(log, 'b');
	await quietly(() => drainWebSockets(50));
	assert.deepEqual(log, [
		['send', 'a', 'reconnect'],
		['send', 'b', 'reconnect'],
		['end', 'a', 1001, 'Server shutting down'],
		['end', 'b', 1001, 'Server shutting down']
	]);
	assert.equal(wsConnections.size, 0);
});

test('with the advisory off, every connection still closes 1001, unadvised', async () => {
	const log = [];
	liveSocket(log, 'c');
	await quietly(() => drainWebSockets(0));
	assert.deepEqual(log, [['end', 'c', 1001, 'Server shutting down']]);
});

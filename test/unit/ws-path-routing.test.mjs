import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDSHAKE } from '../helpers/handshake.mjs';

// WHOSE A REQUEST ON THE WEBSOCKET PATH IS, on a server with no admission
// limit. svelte-adapter-uws mounts the path as two GET routes, its WebSocket
// route and a GET route that, with no limit to report, yields a GET that is not
// a handshake on to the app; every other method never meets either. `null` from
// tryUpgrade is the app's turn.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	// A block that limits nothing, as uws reads it: zeroes, a pacing queue with
	// no budget to pace, and a cursor lane with no ceiling to carve it from. A
	// server configured so is the app's on this path exactly as one with no
	// block at all.
	upgradeAdmission: { maxConcurrent: 0, maxConnections: 0, perTickBudget: 0, maxDeferred: 8, cursorLane: { fraction: 0.5 } }
};

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { wsCounters } = await import('../../src/runtime/handler/ws-state.js');

function fakeServer() {
	const srv = { taken: 0, upgrade() { srv.taken++; return true; } };
	return srv;
}

/**
 * @param {string} method
 * @param {Record<string, string>} [headers]
 */
function request(method, headers = {}) {
	return new Request('http://127.0.0.1/ws', { method, headers });
}

test('this fixture has no limit, so nothing below is a capacity answer', () => {
	assert.equal(upgradeAdmission, null);
});

test('a GET that is not a handshake goes on to the app', () => {
	const srv = fakeServer();
	assert.equal(tryUpgrade(request('GET'), srv, '/ws'), null);
	assert.equal(tryUpgrade(request('GET', { accept: 'text/html' }), srv, '/ws'), null);
	assert.equal(tryUpgrade(request('GET', { upgrade: 'h2c', connection: 'Upgrade' }), srv, '/ws'), null, 'an upgrade to another protocol');
	assert.equal(srv.taken, 0);
});

test('every method but GET goes on to the app, a complete handshake included', () => {
	const srv = fakeServer();
	for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
		assert.equal(tryUpgrade(request(method, HANDSHAKE), srv, '/ws'), null, method);
	}
	assert.equal(srv.taken, 0, 'no socket was opened for any of them');
	assert.equal(wsCounters.upgradeRejectedTotal, 0, 'and none was counted as a refused upgrade');
});

test('a GET handshake is still the adapter\'s', async () => {
	const srv = fakeServer();
	assert.equal(await tryUpgrade(request('GET', HANDSHAKE), srv, '/ws'), undefined);
	assert.equal(srv.taken, 1);
});

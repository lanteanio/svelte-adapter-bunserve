import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDSHAKE } from '../helpers/handshake.mjs';

// THE HANDSHAKE RULE, wired: a GET on the WebSocket path that tries to open a
// WebSocket and could not complete one is refused 400, or 426 for a version
// this server does not speak, before the capacity gate, the origin check and
// the app's hook - as svelte-adapter-uws refuses it, and counted as
// `malformed_handshake`. Bun would upgrade most of these itself
// (probe/bun-api-facts.report.md, handshake-cases), so nothing else stands
// between them and a socket.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: ['https://allowed.example'],
	path: '/ws',
	handler: 'src/ws-handler.js',
	// A slot per handshake, returned when it settles, so the gate can be held
	// full on purpose and is otherwise empty.
	upgradeAdmission: { maxConcurrent: 1 }
};

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { upgradeRejectionCounts } = await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

const ALLOWED = 'https://allowed.example';

const srv = { taken: 0, upgrade() { srv.taken++; return true; } };

/** @type {Array<[string, string]>} */
const NORMAL = Object.entries(HANDSHAKE);
const without = (name) => NORMAL.filter(([k]) => k !== name);
const replaced = (name, value) => NORMAL.map(([k, v]) => [k, k === name ? value : v]);
const repeated = (name) => [...NORMAL, NORMAL.find(([k]) => k === name)];

/** svelte-adapter-uws's raw-socket set and that adapter's answers, 101 for an upgrade. */
const CASES = [
	['a complete handshake', NORMAL, 101],
	['no Upgrade', without('upgrade'), 400],
	['no Connection', without('connection'), 400],
	['no key', without('sec-websocket-key'), 400],
	['an Upgrade naming another protocol', replaced('upgrade', 'not-websocket'), 400],
	['a Connection without upgrade', replaced('connection', 'keep-alive'), 400],
	['a 24-character key that is not base64', replaced('sec-websocket-key', '!'.repeat(24)), 400],
	['a short key', replaced('sec-websocket-key', 'a'), 400],
	['a key with its unused bits set', replaced('sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZR=='), 400],
	['Upgrade twice', repeated('upgrade'), 400],
	['the key twice', repeated('sec-websocket-key'), 400],
	['the version twice', repeated('sec-websocket-version'), 400],
	['version 12', replaced('sec-websocket-version', '12'), 426],
	['version 8', replaced('sec-websocket-version', '8'), 426],
	['a version that is not a number', replaced('sec-websocket-version', '13a'), 426],
	['upgrade listed on a second Connection line', [...without('connection'), ['connection', 'keep-alive'], ['connection', 'Upgrade']], 101],
	['no version', without('sec-websocket-version'), 426],
	['a websocket Upgrade with no key', [['connection', 'Upgrade'], ['upgrade', 'websocket']], 400],
	['a key with no Upgrade', [['sec-websocket-key', HANDSHAKE['sec-websocket-key']]], 400]
];

/**
 * A GET with exactly these header lines, joined as Bun joins a repeated one.
 *
 * @param {Array<[string, string]>} lines
 * @param {string} [origin]
 */
function request(lines, origin = ALLOWED) {
	const headers = new Headers();
	for (const [name, value] of lines) headers.append(name, value);
	if (origin) headers.set('origin', origin);
	return new Request('http://127.0.0.1/ws', { headers });
}

/** Hold the one in-flight slot for the length of `fn`. */
async function atCapacity(fn) {
	assert.equal(upgradeAdmission.tryAcquire(), true);
	try {
		return await fn();
	} finally {
		upgradeAdmission.release();
	}
}

/** Swallow the shed and origin log lines, which other suites assert on. */
async function quietly(fn) {
	const warn = console.warn;
	console.warn = () => {};
	try {
		return await fn();
	} finally {
		console.warn = warn;
	}
}

test('answers each case as svelte-adapter-uws does, and counts each refusal once', async () => {
	for (const [name, lines, expected] of CASES) {
		const before = upgradeRejectionCounts();
		const taken = srv.taken;
		const res = await tryUpgrade(request(lines), srv, '/ws');
		const after = upgradeRejectionCounts();
		if (expected === 101) {
			assert.equal(res, undefined, name);
			assert.equal(srv.taken, taken + 1, name);
			assert.equal(after.malformed_handshake, before.malformed_handshake, name);
			continue;
		}
		assert.equal(res.status, expected, name);
		assert.equal(srv.taken, taken, `${name}: no socket`);
		assert.equal(after.malformed_handshake, before.malformed_handshake + 1, `${name}: counted`);
		if (expected === 426) {
			assert.equal(res.headers.get('sec-websocket-version'), '13', name);
			assert.equal(await res.text(), 'Upgrade Required', name);
		} else {
			assert.equal(await res.text(), 'Bad Request', name);
		}
		assert.equal(res.headers.get('content-type'), 'text/plain', name);
	}
});

test('is judged before capacity: a full gate refuses a malformed handshake as malformed', async () => {
	const before = upgradeRejectionCounts();
	const results = await atCapacity(() => quietly(async () => [
		(await tryUpgrade(request(replaced('sec-websocket-key', '!'.repeat(24))), srv, '/ws')).status,
		(await tryUpgrade(request(replaced('sec-websocket-version', '8')), srv, '/ws')).status,
		(await tryUpgrade(request(NORMAL), srv, '/ws')).status
	]));
	assert.deepEqual(results, [400, 426, 503], 'only the complete handshake is shed');
	const after = upgradeRejectionCounts();
	assert.equal(after.malformed_handshake, before.malformed_handshake + 2);
	assert.equal(after.over_capacity, before.over_capacity + 1);
	assert.equal(upgradeAdmission.inFlight, 0, 'and no refusal held a slot');
});

test('is judged before the origin check', async () => {
	const before = upgradeRejectionCounts();
	const res = await quietly(() => tryUpgrade(request(without('sec-websocket-key'), 'https://evil.example'), srv, '/ws'));
	assert.equal(res.status, 400);
	const after = upgradeRejectionCounts();
	assert.equal(after.malformed_handshake, before.malformed_handshake + 1);
	assert.equal(after.bad_origin, before.bad_origin, 'never reached');
});

test('is judged before the app\'s hook, which never sees a malformed handshake', async () => {
	let calls = 0;
	__setHooks({ upgrade: () => { calls++; return {}; } });
	try {
		assert.equal((await tryUpgrade(request(replaced('sec-websocket-version', '8')), srv, '/ws')).status, 426);
		assert.equal((await tryUpgrade(request(without('connection')), srv, '/ws')).status, 400);
		assert.equal(calls, 0);
		assert.equal(await tryUpgrade(request(NORMAL), srv, '/ws'), undefined);
		assert.equal(calls, 1, 'a complete handshake still reaches it');
	} finally {
		__setHooks({});
	}
});

test('a GET that is not trying to open a WebSocket is not judged by it', async () => {
	const before = upgradeRejectionCounts();
	// Under this fixture's ceiling, with room: told to upgrade, not refused.
	assert.equal((await tryUpgrade(request([]), srv, '/ws')).status, 426);
	assert.equal((await tryUpgrade(request([['connection', 'Upgrade'], ['upgrade', 'h2c']]), srv, '/ws')).status, 426);
	assert.equal(upgradeRejectionCounts().malformed_handshake, before.malformed_handshake);
});

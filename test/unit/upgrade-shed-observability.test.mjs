import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// WHAT A SHED UPGRADE LEAVES BEHIND, driven through `tryUpgrade`.
//
// A refusal used to be entirely silent: no counter, no log line, nothing an
// operator could reach. A server doing exactly what it was configured to do was
// therefore indistinguishable from a broken one - the page loads, the socket
// gets a 503, and the process says nothing about which ceiling refused it. This
// adapter already names that failure mode on the origin refusal.
//
// Each case here checks the REASON as well as the count, because the reason is
// the whole value of the line: it names which knob to reach for, and a shed
// labelled with the wrong ceiling sends an operator to the wrong one.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
// A carved cursor lane of exactly one (floor(4 * 0.25)), so the cursor
// sub-budget can be filled while the main lane still has three slots free -
// which is what makes the cursor case distinguishable from plain over-capacity.
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { maxConcurrent: 4, maxConnections: 6, cursorLane: { fraction: 0.25 } }
};

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { CURSOR_LANE_SUBPROTOCOL } = await import('../../src/runtime/utils/upgrade-admission.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/** A server that accepts every upgrade and remembers how many it took. */
function fakeServer() {
	const srv = {
		taken: 0,
		upgrade() { srv.taken++; return true; }
	};
	return srv;
}

/** Resolvers for every hook call currently parked. */
const parked = [];

/** Hold every handshake inside the app hook, so in-flight slots stay taken. */
function parkHooks() {
	__setHooks({ upgrade: () => new Promise((resolve) => parked.push(resolve)) });
}

/** Let the parked hooks return and stop parking new ones. */
function releaseHooks() {
	__setHooks({});
	for (const resolve of parked.splice(0)) resolve({});
}

/** @param {{ cursor?: boolean }} [opts] */
function upgradeRequest(opts = {}) {
	const headers = { upgrade: 'websocket', connection: 'Upgrade' };
	if (opts.cursor) headers['sec-websocket-protocol'] = CURSOR_LANE_SUBPROTOCOL;
	return new Request('http://127.0.0.1/ws', { headers });
}

/** Drain microtasks so a parked handshake has provably reached the hook. */
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Run `fn` with console.warn captured, and hand back everything it wrote.
 *
 * @param {() => Promise<any>} fn
 * @returns {Promise<{ result: any, warnings: string[] }>}
 */
async function capturingWarnings(fn) {
	const warnings = [];
	const real = console.warn;
	console.warn = (/** @type {unknown} */ m) => { warnings.push(String(m)); };
	try {
		return { result: await fn(), warnings };
	} finally {
		console.warn = real;
	}
}

test('the controller is live for this fixture, so the checks below can fail', () => {
	assert.notEqual(upgradeAdmission, null, 'admission is configured');
	assert.equal(upgradeAdmission.maxConcurrent, 4);
	assert.equal(upgradeAdmission.cursorMaxConcurrent, 1, 'a lane of one, carved from four');
	assert.equal(upgradeAdmission.rejectedTotal, 0, 'nothing has been refused yet');
});

test('a shed at the concurrent-upgrade ceiling is counted and named', async () => {
	const srv = fakeServer();
	parkHooks();
	const held = [];
	for (let i = 0; i < 4; i++) held.push(tryUpgrade(upgradeRequest(), srv, '/ws'));
	await settle();
	assert.equal(upgradeAdmission.inFlight, 4, 'the main lane is full');

	const before = upgradeAdmission.rejectedByReason;
	const { result, warnings } = await capturingWarnings(
		() => tryUpgrade(upgradeRequest(), srv, '/ws')
	);
	assert.ok(result && result.status === 503, 'the fifth handshake is shed');

	const after = upgradeAdmission.rejectedByReason;
	assert.equal(after.over_capacity, before.over_capacity + 1, 'counted under its own reason');
	assert.equal(after.cursor_lane, before.cursor_lane, 'and under no other');
	assert.equal(upgradeAdmission.rejectedTotal, 1, 'and in the total');

	assert.equal(warnings.length, 1, 'and said out loud, once');
	assert.match(warnings[0], /concurrent-upgrade ceiling/, 'naming which ceiling refused it');
	assert.match(warnings[0], /4 of 4/, 'with both sides of the comparison');
	assert.match(warnings[0], /maxConcurrent/, 'and the knob that raises it');

	releaseHooks();
	await Promise.all(held);
	assert.equal(srv.taken, 4, 'only the admitted four reached the server');
});

test('a shed on the cursor sub-budget names the lane, not the main ceiling', async () => {
	// The distinguishing case: the main lane has three free slots, so a refusal
	// here can only be the sub-budget - and reporting it as over-capacity would
	// send an operator to raise `maxConcurrent`, which would not help.
	const srv = fakeServer();
	parkHooks();
	const held = tryUpgrade(upgradeRequest({ cursor: true }), srv, '/ws');
	await settle();
	assert.equal(upgradeAdmission.cursorInFlight, 1, 'the lane is full');
	assert.equal(upgradeAdmission.inFlight, 1, 'while the main lane has room to spare');

	const before = upgradeAdmission.rejectedByReason;
	const { result, warnings } = await capturingWarnings(
		() => tryUpgrade(upgradeRequest({ cursor: true }), srv, '/ws')
	);
	assert.ok(result && result.status === 503, 'the second cursor handshake is shed');

	const after = upgradeAdmission.rejectedByReason;
	assert.equal(after.cursor_lane, before.cursor_lane + 1, 'counted as a lane refusal');
	assert.equal(after.over_capacity, before.over_capacity, 'not as main-lane pressure');

	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /cursor lane/, 'naming the lane');
	assert.match(warnings[0], /1 of 1/, 'with the sub-budget it filled');
	assert.match(warnings[0], /main lane 1 of 4/, 'and the headroom that is not the problem');
	assert.match(warnings[0], /cursorLane\.fraction/, 'and the knob that widens it');

	releaseHooks();
	await held;
});

test('a shed at the connection ceiling names that ceiling', async () => {
	// LAST in the file: it fills the permit pool, and a permit is only released
	// by a socket closing - these sockets are a fake server's counter and never
	// do. Sequential handshakes, so the in-flight lane is empty each time and
	// cannot be what refuses.
	const srv = fakeServer();
	releaseHooks();
	let admitted = 0;
	for (;;) {
		const res = await tryUpgrade(upgradeRequest(), srv, '/ws');
		if (res !== undefined) break;
		admitted++;
		assert.ok(admitted <= upgradeAdmission.maxConnections, 'the ceiling must bind eventually');
	}
	assert.equal(upgradeAdmission.connectionPermits, upgradeAdmission.maxConnections, 'the pool is full');
	assert.equal(upgradeAdmission.inFlight, 0, 'and nothing is in flight, so the lane is not what refused');

	const before = upgradeAdmission.rejectedByReason;
	const { result, warnings } = await capturingWarnings(
		() => tryUpgrade(upgradeRequest(), srv, '/ws')
	);
	assert.ok(result && result.status === 503);

	const after = upgradeAdmission.rejectedByReason;
	assert.equal(after.connection_capacity, before.connection_capacity + 1);
	assert.equal(after.over_capacity, before.over_capacity, 'an empty lane is not over capacity');

	assert.ok(warnings.length >= 1);
	const line = warnings[warnings.length - 1];
	assert.match(line, /connection ceiling/, 'naming the ceiling');
	assert.match(line, /6 of 6/, 'with both sides of the comparison');
	assert.match(line, /maxConnections/, 'and the knob that raises it');
});

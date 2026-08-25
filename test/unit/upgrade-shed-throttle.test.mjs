import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE SHED LINE'S THROTTLE, which is the difference between a diagnostic and an
// amplifier. A refusal costs an attacker one packet, so a line per refusal is
// stderr the gate itself pays for - synchronous writes to a container's log
// pipe, which is event-loop stall and disk fill bought with no authentication.
//
// Its own file because the schedule is module state: `createLogThrottle` counts
// per category, so any earlier test in the same file has already advanced the
// counter for whichever reason it drove, and an assertion about "the first nine
// and then powers of ten" would be asserting against wherever that left it.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
// One of everything: a main ceiling of one, and a lane carved from it, so both
// an `over_capacity` storm and a `cursor_lane` refusal are reachable with a
// single parked handshake.
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { maxConcurrent: 1, cursorLane: { fraction: 1 } }
};


const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { CURSOR_LANE_SUBPROTOCOL } = await import('../../src/runtime/utils/upgrade-admission.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

const srv = { taken: 0, upgrade() { srv.taken++; return true; } };

/** @param {{ cursor?: boolean }} [opts] */
function upgradeRequest(opts = {}) {
	const headers = { upgrade: 'websocket', connection: 'Upgrade' };
	if (opts.cursor) headers['sec-websocket-protocol'] = CURSOR_LANE_SUBPROTOCOL;
	return new Request('http://127.0.0.1/ws', { headers });
}

/**
 * @param {() => Promise<any>} fn
 * @returns {Promise<string[]>}
 */
async function warningsFrom(fn) {
	const lines = [];
	const real = console.warn;
	console.warn = (/** @type {unknown} */ m) => { lines.push(String(m)); };
	try {
		await fn();
		return lines;
	} finally {
		console.warn = real;
	}
}

test('the controller is live for this fixture, so the checks below can fail', () => {
	assert.notEqual(upgradeAdmission, null, 'admission is configured');
	assert.equal(upgradeAdmission.maxConcurrent, 1);
	assert.equal(upgradeAdmission.cursorMaxConcurrent, 1, 'a lane, so both reasons are reachable');
});

test('a storm of one reason is throttled, and cannot silence a different one', async () => {
	// One handshake parked inside the app hook fills the only slot there is, so
	// everything behind it is refused for the same reason.
	const parked = [];
	__setHooks({ upgrade: () => new Promise((resolve) => parked.push(resolve)) });
	const held = tryUpgrade(upgradeRequest(), srv, '/ws');
	for (let i = 0; i < 10; i++) await Promise.resolve();
	assert.equal(upgradeAdmission.inFlight, 1, 'the ceiling is full');

	// `shouldLogOccurrence` logs each of the first nine and then powers of ten,
	// so twelve refusals are ten lines. Nothing at the call site pins that
	// unless a test drives more than one refusal of the same reason at once.
	const stormed = await warningsFrom(async () => {
		for (let i = 0; i < 12; i++) await tryUpgrade(upgradeRequest(), srv, '/ws');
	});
	assert.equal(stormed.length, 10, 'twelve refusals, ten lines');
	assert.match(stormed[0], /concurrent-upgrade ceiling/);
	assert.ok(!/occurrence/.test(stormed[0]), 'the first line carries no occurrence count');
	assert.match(stormed[9], /occurrence 10/, 'and the tenth says which one it is');

	// PER REASON, not one schedule shared across all four. A lane refusing
	// constantly would otherwise push the first refusal from a different ceiling
	// out to occurrence 100 - the one line an operator most needs to see.
	const other = await warningsFrom(() => tryUpgrade(upgradeRequest({ cursor: true }), srv, '/ws'));
	assert.equal(other.length, 1, 'a different reason still speaks up immediately');
	assert.match(other[0], /cursor lane/);
	assert.ok(!/occurrence/.test(other[0]), 'on its own first occurrence');

	__setHooks({});
	for (const resolve of parked.splice(0)) resolve({});
	await held;
	assert.equal(srv.taken, 1, 'only the parked handshake ever reached the server');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// THE FOURTH WAY AN UPGRADE IS SHED: the pacing queue is full.
//
// Its own file because the fixture is the opposite of the other shed cases - no
// ceiling at all, only a per-tick budget - and the controller is a module
// singleton, so a budget that tight cannot share a file with tests that admit
// several handshakes per tick.
//
// A queue of zero is a legal configuration and the sharpest one: the budget
// admits the first handshake of a tick and the second has nowhere to wait, so
// the overflow needs no burst to reproduce.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { perTickBudget: 1, maxDeferred: 0 }
};

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');

/** A server that accepts every upgrade and remembers how many it took. */
function fakeServer() {
	const srv = {
		taken: 0,
		upgrade() { srv.taken++; return true; }
	};
	return srv;
}

function upgradeRequest() {
	return new Request('http://127.0.0.1/ws', {
		headers: { upgrade: 'websocket', connection: 'Upgrade' }
	});
}

test('the controller is live for this fixture, so the checks below can fail', () => {
	assert.notEqual(upgradeAdmission, null, 'admission is configured');
	assert.equal(upgradeAdmission.maxDeferred, 0, 'a queue of zero, which is what the overflow needs');
	assert.equal(upgradeAdmission.maxConcurrent, 0, 'and no ceiling, so nothing else can refuse');
});

test('a handshake with nowhere to wait is shed, counted, and named', async () => {
	const srv = fakeServer();
	const warnings = [];
	const real = console.warn;
	console.warn = (/** @type {unknown} */ m) => { warnings.push(String(m)); };

	let first;
	let second;
	try {
		// BOTH started inside one tick, which is what puts the second past the
		// budget: with no app hook the handler runs synchronously as far as the
		// pacing wait, so the second `admit` lands in the same tick as the first.
		first = tryUpgrade(upgradeRequest(), srv, '/ws');
		second = tryUpgrade(upgradeRequest(), srv, '/ws');
		assert.equal(await first, undefined, 'the first handshake spends this tick\'s budget');
		const shed = await second;
		assert.ok(shed && shed.status === 503, `the second has nowhere to wait, got ${shed && shed.status}`);
	} finally {
		console.warn = real;
	}

	assert.equal(upgradeAdmission.rejectedByReason.deferred_overflow, 1, 'counted by reason');
	assert.equal(upgradeAdmission.rejectedTotal, 1, 'and in the total');
	// Both counters, as uws keeps both: the reason-labelled one alongside the
	// dedicated overflow counter, so a queue that is dropping work is visible
	// without having to read the reason breakdown.
	assert.equal(upgradeAdmission.deferredRejectedTotal, 1, 'and by the queue itself');

	assert.equal(warnings.length, 1, 'and said out loud, once');
	assert.match(warnings[0], /pacing queue/, 'naming what refused it');
	assert.match(warnings[0], /perTickBudget/, 'and the knob that widens it');
	assert.equal(srv.taken, 1, 'only the admitted handshake reached the server');
});

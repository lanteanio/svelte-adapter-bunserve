import { test } from 'node:test';
import assert from 'node:assert/strict';

// THE WIRING, not the counters.
//
// `createUpgradeAdmission` had thorough unit tests and `admission-check.mjs`
// drove a real server, and between them two defects still shipped: every cursor
// upgrade was refused forever whenever the lane was not carved, and a handshake
// parked in the pacing queue could be admitted onto a process that had already
// drained. Both live in `tryUpgrade`, and nothing called `tryUpgrade`.
//
// So this drives it directly, with a fake server that records what it was asked
// to do. The build-time globals have to be in place before the module graph is
// imported, because `admission.js` builds its controller at import.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
// A ceiling on connections but NO `maxConcurrent`, plus a cursor lane. This is
// the configuration the README's own example leads to and the one that used to
// refuse every cursor socket: the lane is carved from `maxConcurrent`, so with
// none set `cursorMaxConcurrent` is zero.
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	upgradeAdmission: { maxConnections: 4, perTickBudget: 1, maxDeferred: 8, cursorLane: { fraction: 0.25 } }
};


const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { resetRuntimeEnv, setRuntimeEnv } = await import('../../src/runtime/runtime.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { beginDraining, wsCounters } = await import('../../src/runtime/handler/ws-state.js');
const { CURSOR_LANE_SUBPROTOCOL } = await import('../../src/runtime/utils/upgrade-admission.js');

/** A server that accepts every upgrade and remembers how many it took. */
function fakeServer() {
	const srv = {
		taken: 0,
		upgrade() { srv.taken++; return true; }
	};
	return srv;
}

/**
 * @param {{ cursor?: boolean }} [opts]
 */
function upgradeRequest(opts = {}) {
	const headers = { upgrade: 'websocket', connection: 'Upgrade' };
	if (opts.cursor) headers['sec-websocket-protocol'] = CURSOR_LANE_SUBPROTOCOL;
	return new Request('http://127.0.0.1/ws', { headers });
}

const attempt = async (srv, opts) => tryUpgrade(upgradeRequest(opts), srv, '/ws');

test('the controller is live for this fixture, so the checks below can fail', () => {
	// A guard on the guard: were the block to normalize away, every assertion
	// here would pass against a server with no admission at all.
	assert.notEqual(upgradeAdmission, null, 'admission is configured');
	assert.equal(upgradeAdmission.maxConnections, 4);
	assert.equal(upgradeAdmission.cursorMaxConcurrent, 0, 'no maxConcurrent to carve a lane from');
});

test('a cursor upgrade is NOT refused when the lane was never carved', async () => {
	// The regression this file exists for. `tryAcquireCursor` refuses whenever
	// cursorInFlight >= cursorMaxConcurrent, so an uncarved lane (ceiling 0)
	// refuses 0 >= 0 - every cursor socket, forever, on an idle server. Routing
	// has to be gated on the lane EXISTING, not on the token being offered.
	const srv = fakeServer();
	const res = await attempt(srv, { cursor: true });
	assert.equal(res, undefined, `expected the upgrade to be taken, got ${res && res.status}`);
	assert.equal(srv.taken, 1);
});

test('a plain upgrade and a cursor upgrade are both admitted on an idle server', async () => {
	const srv = fakeServer();
	assert.equal(await attempt(srv), undefined, 'plain');
	assert.equal(await attempt(srv, { cursor: true }), undefined, 'cursor');
	assert.equal(srv.taken, 2);
});

test('a crossed connection ceiling sheds with the retry-after uws sends', async () => {
	// The band is real, and both of its edges are reachable: the arithmetic is
	// uws's jitterRetryAfter, whose two-value floor turned the old constant 2
	// into 2..3 at the shared base. Each edge is pinned through an injected
	// RNG, because twenty draws of a real RNG can legally answer the same
	// second twenty times - a green that proves nothing.
	const srv = fakeServer();
	// Filled by admitting until one is refused, rather than by counting up to
	// `maxConnections`: the controller is a module singleton, so sockets opened
	// by earlier tests in this file still hold permits and the headroom here is
	// whatever they left.
	let admitted = 0;
	let first;
	for (;;) {
		first = await attempt(srv);
		if (first !== undefined) break;
		admitted++;
		assert.ok(admitted <= upgradeAdmission.maxConnections, 'the ceiling must bind eventually');
	}
	assert.equal(srv.taken, admitted, 'nothing past the ceiling reached the server');
	assert.ok(first && first.status === 503, 'past the ceiling the upgrade is shed');
	const firstValue = Number(first.headers.get('retry-after'));
	assert.ok(firstValue >= 2 && firstValue <= 3, `retry-after out of band: ${firstValue}`);

	try {
		setRuntimeEnv({ rng: { float: () => 0 } });
		const floor = await attempt(srv);
		assert.equal(floor.headers.get('retry-after'), '2', 'the band floor is the base');
		setRuntimeEnv({ rng: { float: () => 0.999 } });
		const top = await attempt(srv);
		assert.equal(top.headers.get('retry-after'), '3', 'and the top of the band is reachable');
		// The cursor lane sheds through the same funnel and answers the same
		// band - the lane a herd of reconnecting workers actually hits.
		const cursorTop = await attempt(srv, { cursor: true });
		assert.equal(cursorTop.status, 503);
		assert.equal(cursorTop.headers.get('retry-after'), '3', 'the cursor lane draws the same band');
	} finally {
		resetRuntimeEnv();
	}
	assert.equal(srv.taken, admitted, 'and nothing past the ceiling reached the server');
});

test('an escalated posture widens the band, on every lane that sheds', async () => {
	// A server at siege is refusing a bigger herd per second than one at
	// normal, so telling that herd to come back inside the same two seconds is
	// the thing the jitter exists to prevent. uws widens the spread with the
	// posture; this pins that the widening reaches a REFUSAL rather than only
	// the arithmetic - the shed lane read no posture at all and answered the
	// normal band under every level.
	const srv = fakeServer();
	let admitted = 0;
	let refused;
	for (;;) {
		refused = await attempt(srv);
		if (refused !== undefined) break;
		admitted++;
		assert.ok(admitted <= upgradeAdmission.maxConnections, 'the ceiling must bind eventually');
	}
	assert.equal(refused.status, 503);

	try {
		// Both edges at every posture, through an injected RNG: a real one can
		// legally draw the same second every time, which is a green proving
		// nothing. `elevated` reads the same as `normal` at this base on
		// purpose - ceil(2 * 1) and the floor of 2 agree at 2 - and the value
		// is pinned rather than skipped so a spread table that stopped
		// distinguishing them elsewhere still has to say so here.
		for (const [level, top] of [['normal', '3'], ['elevated', '3'], ['siege', '4']]) {
			wsCounters.activePosture = /** @type {any} */ ({ level });

			setRuntimeEnv({ rng: { float: () => 0 } });
			assert.equal((await attempt(srv)).headers.get('retry-after'), '2',
				`${level}: the floor is the base`);
			assert.equal((await attempt(srv, { cursor: true })).headers.get('retry-after'), '2',
				`${level}: the cursor lane floor is the base too`);

			setRuntimeEnv({ rng: { float: () => 0.999 } });
			assert.equal((await attempt(srv)).headers.get('retry-after'), top,
				`${level}: the top of the band`);
			assert.equal((await attempt(srv, { cursor: true })).headers.get('retry-after'), top,
				`${level}: the cursor lane draws the same band`);
		}

		// No posture machine running at all is the zero-config server, and it
		// answers the normal band rather than throwing on a missing level.
		wsCounters.activePosture = null;
		setRuntimeEnv({ rng: { float: () => 0.999 } });
		assert.equal((await attempt(srv)).headers.get('retry-after'), '3',
			'an unposted server answers the normal band');
	} finally {
		wsCounters.activePosture = null;
		resetRuntimeEnv();
	}
	assert.equal(srv.taken, admitted, 'and nothing past the ceiling reached the server');
});

test('a handshake parked by pacing is refused if a drain begins while it waits', async () => {
	// `perTickBudget: 1` guarantees the second arrival of a tick is queued. The
	// drain latch is taken synchronously on SIGTERM, so without a re-check after
	// the wait the parked socket lands on a process that has already walked its
	// live connections - no advisory, no 1012, and a 1006 when stop(true) comes.
	const srv = fakeServer();
	// ONE subject, so the assertion cannot be satisfied by some other arrival
	// being refused somewhere else. This tick's budget is spent directly on the
	// controller, which guarantees the handshake below parks instead of running
	// synchronously.
	upgradeAdmission.admit(() => {});
	const parked = attempt(srv);

	// Yield MICROTASKS only - never a macrotask - until it is provably sitting
	// in the pacing queue. That is what isolates the re-check from the drain
	// check preceding the wait: reaching the queue means the earlier check has
	// already passed. The drain runs on setImmediate, so staying off the
	// macrotask queue also guarantees nothing is released early.
	// At least one: earlier tests in this file leave the tick budget in whatever
	// state they left it, so the dummy above may itself have been queued rather
	// than run. What matters is that the handshake is in the queue behind it.
	for (let i = 0; i < 100 && upgradeAdmission.deferredDepth === 0; i++) await Promise.resolve();
	assert.ok(upgradeAdmission.deferredDepth >= 1, 'the handshake is parked, past the pre-pacing drain check');

	beginDraining();
	const res = await parked;
	// The falsifiable part: without the re-check this handshake is admitted onto
	// a process that has already walked its live connections and drained.
	assert.ok(res && res.status === 503, `a parked handshake must not be admitted mid-drain, got ${res && res.status}`);
	assert.equal(srv.taken, 0, 'and the server was never asked to take it');
});

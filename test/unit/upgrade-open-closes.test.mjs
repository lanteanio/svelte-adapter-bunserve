import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDSHAKE } from '../helpers/handshake.mjs';

// AN `open` HOOK THAT CLOSES ITS SOCKET, which is where the permit accounting
// gets its ordering wrong if it trusts the shape of the code rather than the
// runtime.
//
// `srv.upgrade()` does not merely hand the socket over for later. It dispatches
// `open` SYNCHRONOUSLY, and an `open` that closes its socket fires the
// request's abort signal and then the close callback - all before that call
// returns. Measured order, from `probe/bun-api-facts.report.md` (upgrade-abort)
// and the dispatch probe behind it:
//
//   before srv.upgrade -> open enters -> abort event -> close callback ->
//   open exits -> srv.upgrade returns true
//
// So a handshake that still believes it owns the connection permit when it
// calls `srv.upgrade` is wrong twice over: the hang-up listener releases the
// permit from inside the call, and then the socket's close callback releases it
// again. `releaseConnection()` throws on that second release, from a callback
// where a throw strands everything behind it - the app's `close` hook, the
// subscription teardown, the registry removal.
//
// Apps that do this are ordinary: refusing an unauthenticated session,
// enforcing one socket per user, turning away a full room. The adapter's own
// control-egress guard does it too.

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	// A permit ceiling is what makes the double release observable at all:
	// `releaseConnection` only throws where a ceiling is configured.
	upgradeAdmission: { maxConnections: 4 }
};


const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');
const { WS_PLATFORM, WS_SUBSCRIPTIONS } = await import('../../src/runtime/handler/ws-state.js');
const { _resetAssertionCountsForTest, readAssertionCounts } = await import('../../src/runtime/utils/assertions.js');

/**
 * A server that replays the runtime's measured dispatch order inside
 * `upgrade()`: the socket opens, the app's open hook closes it, the request
 * aborts, and the REAL close callback runs its permit accounting - all before
 * the call returns.
 *
 * Both handlers are the adapter's own (`websocketHandlers.open` and `.close`),
 * not stand-ins, because the half of this bug that throws lives in close and
 * the permit it releases is the one open took over.
 *
 * @param {AbortController} client the handshake's own controller, so the abort
 *   fires from inside the upgrade exactly as the runtime fires it
 */
function closingServer(client) {
	const srv = {
		taken: 0,
		closed: 0,
		/** @param {Request} _req @param {{ data: any }} opts */
		upgrade(_req, opts) {
			srv.taken++;
			const raw = rawSocket(opts.data, () => {
				// The runtime reports the socket going away on the request
				// first, then runs the close callback.
				client.abort();
				srv.closed++;
			});
			websocketHandlers.open(raw);
			return true;
		}
	};
	return srv;
}

/** An open hook that turns the connection away, as an app refusing a session does. */
const refuseInOpen = (/** @type {any} */ ws) => ws.end(4401, 'unauthenticated');

/**
 * The minimum of Bun's ServerWebSocket the open and close paths touch. Closing
 * it runs the close callback from inside the close call, as Bun does.
 *
 * @param {any} data
 * @param {() => void} [beforeCloseCallback]
 */
function rawSocket(data, beforeCloseCallback) {
	const raw = {
		data,
		readyState: 1,
		close(/** @type {number} */ code, /** @type {string} */ reason) { shut(code ?? 1000, reason); },
		terminate() { shut(1006, ''); },
		send() { return 1; },
		subscribe() {},
		unsubscribe() {},
		getBufferedAmount() { return 0; },
		isSubscribed() { return false; },
		cork(/** @type {() => unknown} */ fn) { return fn(); }
	};
	/** @param {number} code @param {string | undefined} reason */
	function shut(code, reason) {
		if (raw.readyState !== 1) return;
		raw.readyState = 3;
		if (beforeCloseCallback) beforeCloseCallback();
		websocketHandlers.close(raw, code, String(reason ?? ''));
	}
	return raw;
}

function upgradeRequest(signal) {
	return new Request('http://127.0.0.1/ws', {
		headers: { ...HANDSHAKE },
		signal
	});
}

test('the fixture has a permit ceiling, so an over-release would throw', () => {
	assert.notEqual(upgradeAdmission, null);
	assert.equal(upgradeAdmission.maxConnections, 4);
});

test('an `open` that closes its socket does not release the permit twice', async () => {
	__setHooks({ open: refuseInOpen });
	const client = new AbortController();
	const srv = closingServer(client);
	const before = upgradeAdmission.connectionPermits;
	const overReleasesBefore = upgradeAdmission.overReleaseTotal;

	// `releaseConnection` counts an over-release before it throws, and the
	// count is the assertion that matters: here the throw comes out of the
	// close callback nested inside the app's open hook, whose boundary
	// contains it, so the handshake would still look successful.
	const res = await tryUpgrade(upgradeRequest(client.signal), srv, '/ws');

	assert.equal(srv.taken, 1, 'the runtime was asked to take the socket');
	assert.equal(srv.closed, 1, 'and the socket closed inside that call');
	assert.equal(res, undefined, 'the handshake still reports success to the runtime');
	assert.equal(
		upgradeAdmission.overReleaseTotal,
		overReleasesBefore,
		'the permit was never released a second time'
	);
	assert.equal(
		upgradeAdmission.connectionPermits,
		before,
		'the permit was released exactly once - by the socket that took it'
	);
	assert.equal(upgradeAdmission.inFlight, 0, 'and the upgrade window is closed');
});

test('the app close hook still runs, rather than being stranded by a throw', async () => {
	// The consequence that makes the double release worse than a miscount: the
	// release sits near the top of the close callback, so a throw there skips
	// the app's hook and every teardown behind it.
	const seen = [];
	__setHooks({ open: refuseInOpen, close: () => { seen.push('close'); } });
	try {
		const client = new AbortController();
		const srv = closingServer(client);
		await tryUpgrade(upgradeRequest(client.signal), srv, '/ws');
		assert.deepEqual(seen, ['close'], 'the close hook ran');
	} finally {
		__setHooks({});
	}
});

test('a socket that closes later still returns its permit exactly once', async () => {
	// The ordinary case, kept beside the synchronous one: the permit has to
	// survive the hand-over and come back at the real close, or the ceiling
	// ratchets down to zero over the life of the process.
	const srv = { taken: 0, upgrade() { srv.taken++; return true; } };
	const client = new AbortController();
	const before = upgradeAdmission.connectionPermits;

	let carried;
	srv.upgrade = (_req, opts) => { carried = opts.data; srv.taken++; return true; };
	assert.equal(await tryUpgrade(upgradeRequest(client.signal), srv, '/ws'), undefined);
	assert.equal(upgradeAdmission.connectionPermits, before + 1, 'the socket holds a permit');

	__setHooks({});
	const raw = rawSocket(carried);
	websocketHandlers.open(raw);
	raw.close(1000, '');
	assert.equal(upgradeAdmission.connectionPermits, before, 'and gives it back on close');

	// A second close must be a no-op rather than an over-release.
	websocketHandlers.close(rawSocket(carried), 1000, '');
	assert.equal(upgradeAdmission.connectionPermits, before, 'a second close releases nothing');
});

test('a socket that opens without the permit the upgrade stamps is stopped before it is built', () => {
	// Every upgrade through the gate stamps the permit on the socket's data
	// before `srv.upgrade`, and close is what gives it back - so a socket
	// arriving without one was admitted past the ceiling's count, and nothing
	// about its accounting can be trusted. Under test that throws; in production
	// the process exits 78 rather than run on with it.
	__setHooks({});
	_resetAssertionCountsForTest();
	const realError = console.error;
	console.error = () => {};
	try {
		const raw = rawSocket(upgradeData());
		assert.doesNotThrow(() => websocketHandlers.open(raw));
		assert.equal(readAssertionCounts().get('ws.connection-permit-carrier'), 1);
		assert.equal(raw.data[WS_PLATFORM], undefined, 'no platform was installed');
		assert.equal(raw.data[WS_SUBSCRIPTIONS], undefined, 'and no subscription set');
	} finally {
		console.error = realError;
		_resetAssertionCountsForTest();
	}
});

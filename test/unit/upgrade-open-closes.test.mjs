import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');

/**
 * A server that replays the runtime's measured dispatch order inside
 * `upgrade()`: the socket opens, the app closes it, the request aborts, and the
 * REAL close callback runs its permit accounting - all before the call returns.
 *
 * The close handler is the adapter's own (`websocketHandlers.close`), not a
 * stand-in, because the half of this bug that throws lives there.
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
			// `open` runs here, and closes. The runtime reports the socket going
			// away on the request first, then runs the close callback.
			client.abort();
			srv.closed++;
			websocketHandlers.close(rawSocket(opts.data), 1000, '');
			return true;
		}
	};
	return srv;
}

/** The minimum of Bun's ServerWebSocket the close path touches. */
function rawSocket(data) {
	return {
		data,
		readyState: 3,
		close() {},
		terminate() {},
		send() { return 1; },
		subscribe() {},
		unsubscribe() {},
		getBufferedAmount() { return 0; },
		isSubscribed() { return false; },
		cork(fn) { return fn(); }
	};
}

function upgradeRequest(signal) {
	return new Request('http://127.0.0.1/ws', {
		headers: { upgrade: 'websocket', connection: 'Upgrade' },
		signal
	});
}

test('the fixture has a permit ceiling, so an over-release would throw', () => {
	assert.notEqual(upgradeAdmission, null);
	assert.equal(upgradeAdmission.maxConnections, 4);
});

test('an `open` that closes its socket does not release the permit twice', async () => {
	const client = new AbortController();
	const srv = closingServer(client);
	const before = upgradeAdmission.connectionPermits;

	// The whole assertion: this must not throw. `releaseConnection` throws on
	// over-release, and here that throw comes out of the close callback.
	const res = await tryUpgrade(upgradeRequest(client.signal), srv, '/ws');

	assert.equal(srv.taken, 1, 'the runtime was asked to take the socket');
	assert.equal(srv.closed, 1, 'and the socket closed inside that call');
	assert.equal(res, undefined, 'the handshake still reports success to the runtime');
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
	__setHooks({ close: () => { seen.push('close'); } });
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

	websocketHandlers.close(rawSocket(carried), 1000, '');
	assert.equal(upgradeAdmission.connectionPermits, before, 'and gives it back on close');

	// A second close must be a no-op rather than an over-release.
	websocketHandlers.close(rawSocket(carried), 1000, '');
	assert.equal(upgradeAdmission.connectionPermits, before, 'a second close releases nothing');
});

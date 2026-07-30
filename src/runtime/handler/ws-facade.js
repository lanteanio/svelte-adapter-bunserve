/**
 * The socket facade: one wrapper per connection presenting Bun's
 * `ServerWebSocket` through the uWS-shaped surface that hook code, plugins, and
 * the extensions package are written against.
 *
 * This is REQUIRED equipment, not a convenience layer, for one reason: Bun
 * throws on nothing. A closed socket's `subscribe()` returns `true`, its
 * `getBufferedAmount()` returns 0, and its `send()` returns 0 (all probed - see
 * probe/bun-api-facts.report.md, `closed-socket-behavior`). uWS throws on every
 * one of those, and consumers depend on the throw: the extensions' cursor and
 * presence modules call raw `ws.subscribe(...)` inside a try/catch and convert
 * the throw into a `WsClosedError` so the caller can roll back. Hand them a
 * bare Bun socket and that catch never fires - the attach reports success, the
 * connection receives nothing, and the RPC metric records status=ok. A silent
 * success is a worse failure than an exception.
 *
 * Two further contracts live here:
 *
 * 1. THE SEND ORDERING CONTRACT. The closed check runs BEFORE mapSendResult,
 *    because Bun's `0` return is ambiguous between "past the backpressure
 *    limit" and "socket is closed" while the platform treats those two
 *    differently: a closed send is caught into the closedWsAborts lane and
 *    poisons nothing, whereas a backpressure drop poisons this connection's
 *    wire state. Mapping first would book every closed send as a drop. See
 *    utils/send-result.js.
 *
 * 2. IDENTITY STABILITY. Exactly one facade exists per connection, so the
 *    object can be held in a Set (the live-connection registry) and compared by
 *    identity (the `excludeWs` echo suppression). A fresh wrapper per call
 *    would silently break both: the Set would grow without bound and every
 *    exclusion check would miss.
 *
 * The uWS spelling is kept deliberately - `end()` closes gracefully, `close()`
 * cuts hard - because that is what the ported call sites say. Bun spells those
 * `close()` and `terminate()` respectively, so the two names cross over here;
 * getting them backwards turns every graceful close into a 1006 at the client.
 */

import { mapSendResult } from '../utils/send-result.js';

/** Bun's ServerWebSocket.readyState value for an open socket. */
const OPEN = 1;

/**
 * Thrown by every facade method that uWS would have thrown from. Carries a
 * `code` so a consumer can pattern-match instead of string-matching a message.
 */
export class WsClosedError extends Error {
	/**
	 * @param {string} operation - the facade method that refused, e.g. 'subscribe'
	 */
	constructor(operation) {
		super(`WebSocket is closed (${operation})`);
		this.name = 'WsClosedError';
		this.code = 'WS_CLOSED';
		this.operation = operation;
	}
}

/** raw ServerWebSocket -> its one facade. Weak so a closed socket is collectable. */
const facades = new WeakMap();

let warnedCloseArgs = false;
/** One-shot: it describes a static call shape, not a per-frame condition. */
function warnCloseArgs() {
	if (warnedCloseArgs) return;
	warnedCloseArgs = true;
	console.warn(
		'[ws] ws.close(code, reason) was called. This socket is uWS-shaped, where close() is the\n' +
		'  HARD cut (client sees 1006) and end(code, reason) is the graceful close. The arguments\n' +
		'  have been honoured as a graceful close, which is what they mean; use end(code, reason)\n' +
		'  to say so directly, or close() with no arguments for the hard cut.'
	);
}

/**
 * Wrap one raw Bun socket. Idempotent: calling this twice for the same socket
 * returns the same facade, which is what keeps identity stable across the
 * open/message/drain/close handlers.
 *
 * @param {any} raw - Bun ServerWebSocket
 * @returns {any} the facade
 */
export function wsFacade(raw) {
	const existing = facades.get(raw);
	if (existing !== undefined) return existing;

	// Set by the close handler. Kept alongside the readyState probe rather than
	// instead of it: readyState is authoritative once Bun has updated it, and
	// the flag covers the window inside our own close handler, where consumers
	// may still be holding the socket and Bun has not necessarily flipped the
	// state yet.
	let closed = false;

	/**
	 * Set once the close handler has finished with this connection, which is
	 * when userData stops being readable. Separate from `closed`: writes must
	 * fail the moment the socket goes, but the close hook still has to be able
	 * to identify the connection it is tearing down.
	 */
	let detached = false;

	/**
	 * @param {string} operation
	 */
	function assertOpen(operation) {
		if (closed || raw.readyState !== OPEN) throw new WsClosedError(operation);
	}

	const facade = {
		/**
		 * The connection's userData, set at `server.upgrade(req, { data })`.
		 *
		 * Throws once the connection is DETACHED, not merely closed - and the
		 * difference is load-bearing in both directions.
		 *
		 * It has to throw eventually, because consumers build their
		 * closed-socket rollback on it: the extensions registry wraps
		 * `identify(ws)` + `getUserData()` in a try/catch whose comment says
		 * "both throw on a freed native handle; bail silently ... No state to
		 * roll back yet" (svelte-adapter-uws-extensions/src/redis/registry.js).
		 * With a never-throwing read, that catch never fired and the code walked
		 * on to register a CLOSED socket in the shared Redis registry, which
		 * nothing would ever remove.
		 *
		 * It must NOT throw during the close handler, because the same consumer
		 * calls `identify(ws)` UNGUARDED inside its own `close` hook, and uWS
		 * keeps userData valid for the duration of that callback. Throwing there
		 * aborts the hook at its first line and produces the very stale registry
		 * entry the paragraph above describes - the same bug from the opposite
		 * side. Detaching after the hook returns matches uWS's "freed once the
		 * handler is done" lifetime.
		 */
		getUserData() {
			if (detached) throw new WsClosedError('getUserData');
			return raw.data;
		},

		/**
		 * Unchecked userData read, for the adapter's own teardown only.
		 *
		 * The close handler marks the socket closed FIRST (so nothing hands a
		 * dead socket out), then still has to read userData to run the app's
		 * close hook and settle the counters. Routing that through the checked
		 * accessor would abort every close before the hook. Underscored because
		 * it is not part of the socket surface apps or plugins write against.
		 */
		_rawUserData() {
			return raw.data;
		},

		/**
		 * Send one frame. Returns the uWS tri-state (0 enqueued / 1 sent /
		 * 2 dropped), NOT Bun's byte count.
		 *
		 * `isBinary` is accepted for call-site compatibility but does not select
		 * the opcode: Bun derives that from the payload type, so a string is a
		 * text frame and a Uint8Array/ArrayBuffer is a binary frame. Passing
		 * isBinary=true with a string payload does NOT produce a binary frame -
		 * pass bytes instead.
		 *
		 * @param {string | Uint8Array | ArrayBuffer} payload
		 * @param {boolean} [isBinary]
		 * @param {boolean} [compress]
		 * @returns {0 | 1 | 2}
		 */
		send(payload, isBinary, compress) {
			// ORDERING: closed first, mapping second. See the module comment.
			assertOpen('send');
			return mapSendResult(raw.send(payload, compress));
		},

		/**
		 * Publish to a topic from this connection. Excludes this socket by
		 * default (Bun's publishToSelf defaults to false - probed).
		 *
		 * @param {string} topic
		 * @param {string | Uint8Array | ArrayBuffer} payload
		 * @param {boolean} [isBinary]
		 * @param {boolean} [compress]
		 * @returns {0 | 1 | 2}
		 */
		publish(topic, payload, isBinary, compress) {
			assertOpen('publish');
			return mapSendResult(raw.publish(topic, payload, compress));
		},

		/**
		 * @param {string} topic
		 * @returns {boolean}
		 */
		subscribe(topic) {
			// Bun returns true here even on a closed socket. The whole reason
			// this facade exists.
			assertOpen('subscribe');
			return raw.subscribe(topic);
		},

		/**
		 * @param {string} topic
		 * @returns {boolean}
		 */
		unsubscribe(topic) {
			assertOpen('unsubscribe');
			return raw.unsubscribe(topic);
		},

		/**
		 * Membership test. Does NOT throw on a closed socket, matching uWS: a
		 * closed socket is subscribed to nothing, and that is a meaningful
		 * answer rather than an error. Bun already returns false (probed).
		 *
		 * @param {string} topic
		 * @returns {boolean}
		 */
		isSubscribed(topic) {
			if (closed || raw.readyState !== OPEN) return false;
			return raw.isSubscribed(topic);
		},

		/** @returns {number} bytes queued but not yet written */
		getBufferedAmount() {
			assertOpen('getBufferedAmount');
			return raw.getBufferedAmount();
		},

		/**
		 * Graceful close with a code and reason, both of which reach the client
		 * (probed: 4001/"probe-close" observed client-side). uWS spells this
		 * `end`; Bun spells it `close`.
		 *
		 * Safe to call on an already-closed socket: closing twice is a no-op,
		 * not an error, so cleanup paths do not need their own guard.
		 *
		 * @param {number} [code]
		 * @param {string} [reason]
		 */
		end(code, reason) {
			if (closed || raw.readyState !== OPEN) return;
			raw.close(code, reason);
		},

		/**
		 * Hard cut with no close handshake - the client sees 1006. uWS spells
		 * this `close`; Bun spells it `terminate`.
		 *
		 * THE NAME CROSSES OVER, which is the trap: `end()` above is the
		 * graceful close and this is the hard cut, the opposite way round from
		 * Bun. So code written against Bun's own API - `ws.close(1000, 'bye')` -
		 * arrives here meaning a graceful close with a code, and silently
		 * dropping both arguments turned every such call into a 1006 with no
		 * diagnostic. Arguments are therefore honoured as the graceful close the
		 * caller plainly meant, with a one-shot note about the spelling; calling
		 * it with NO arguments keeps the uWS meaning.
		 *
		 * @param {number} [code]
		 * @param {string} [reason]
		 */
		close(code, reason) {
			if (closed || raw.readyState !== OPEN) return;
			if (code !== undefined) {
				warnCloseArgs();
				raw.close(code, reason);
				return;
			}
			raw.terminate();
		},

		/** @returns {number} Bun's readyState (1 = open, 3 = closed) */
		get readyState() {
			return raw.readyState;
		},

		/** The underlying Bun socket, for code that genuinely needs it. */
		get raw() {
			return raw;
		},

		/**
		 * Mark the connection closed. Called once from the close handler, before
		 * any user hook runs, so a hook that reaches for the socket during
		 * cleanup gets the throw rather than a silent no-op.
		 * @internal
		 */
		_markClosed() {
			closed = true;
		},

		/**
		 * Release userData. Called by the close handler AFTER the app's close
		 * hook has been given its turn, so the hook can still identify the
		 * connection while anything resuming later cannot.
		 */
		_markDetached() {
			detached = true;
		},

		/** @returns {boolean} @internal test seam */
		get _closed() {
			return closed || raw.readyState !== OPEN;
		}
	};

	facades.set(raw, facade);
	return facade;
}

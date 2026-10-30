/**
 * The socket facade: one wrapper per connection presenting Bun's
 * `ServerWebSocket` through the uWS-shaped surface that hook code, plugins, and
 * the extensions package are written against.
 *
 * This is REQUIRED equipment, not a convenience layer, for one reason: Bun
 * throws on nothing. A closed socket's `subscribe()` returns `true`, its
 * `getBufferedAmount()` returns 0, and its `send()` returns 0 (all probed - see
 * probe/bun-api-facts.report.md, `closed-socket-behavior`; newer runtimes
 * answer a closed subscribe with `false` instead of `true`, which is still an
 * answer where the contract here is a throw). uWS throws on every
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

import { mapSendResult, SEND_DROPPED, SEND_SUCCESS } from '../utils/send-result.js';
import { NO_STATUS_CLOSE_CODE, closeFrameReason } from '../utils/close-frame.js';
import { framePayload, nativeTopic } from '../utils/recognized-string.js';

/**
 * @param {string | Uint8Array | ArrayBuffer} payload
 * @returns {boolean}
 */
function isEmptyPayload(payload) {
	return typeof payload === 'string' ? payload.length === 0 : payload.byteLength === 0;
}

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

/**
 * Wrap one raw Bun socket. Idempotent: calling this twice for the same socket
 * returns the same facade, which is what keeps identity stable across the
 * open/message/drain/close handlers.
 *
 * @param {any} raw - Bun ServerWebSocket
 * @param {() => any} [getServer] - lazy native server access for publish
 * @returns {any} the facade
 */
export function wsFacade(raw, getServer, getMetricHooks, recordDrop) {
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

	/** Set when end() closed with no code: the close handler reports 0 for it. */
	let noStatusSent = false;
	let hadMembership = (raw.subscriptions?.length ?? 0) > 0;

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
		 * `isBinary` selects the opcode, as on uWS, whatever the payload's
		 * type: the payload is converted to the one Bun sends with that opcode
		 * (utils/recognized-string.js), keeping its bytes.
		 *
		 * @param {string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView} message
		 * @param {boolean} [isBinary]
		 * @param {boolean} [compress]
		 * @returns {0 | 1 | 2}
		 */
		send(message, isBinary, compress) {
			// ORDERING: closed first, mapping second. See the module comment.
			assertOpen('send');
			const payload = framePayload(message, isBinary);
			const result = raw.send(payload, compress);
			// A zero-length payload defeats the byte-count mapping: Bun returns
			// 0 ("zero bytes accepted") both when the empty frame is written to
			// a healthy socket (probed: delivered, nothing buffered afterwards)
			// and when it is dropped past the backpressure limit (probed: never
			// delivered). The backlog is the discriminator - an empty backlog
			// means the frame went out. A socket with ANY backlog takes the
			// conservative DROPPED path: past the limit that is the probed
			// truth, and in the unprobed backpressured-but-under-limit state a
			// false drop self-heals where a false delivery would not.
			if (result === 0 && isEmptyPayload(payload)) {
				const mapped = raw.getBufferedAmount() === 0 ? SEND_SUCCESS : SEND_DROPPED;
				if (mapped === SEND_DROPPED) { recordDrop?.(0); getMetricHooks?.()?.dropped(0); }
				return mapped;
			}
			const mapped = mapSendResult(result);
			if (mapped === SEND_DROPPED) {
				const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
				recordDrop?.(bytes);
				getMetricHooks?.()?.dropped(bytes);
			}
			return mapped;
		},

		/**
		 * Publish to a topic from this connection. Excludes this socket by
		 * default (Bun's publishToSelf defaults to false - probed).
		 *
		 * Topic and message take any recognized string, and `isBinary` selects
		 * the opcode, as for send.
		 *
		 * @param {string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView} name
		 * @param {string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView} message
		 * @param {boolean} [isBinary]
		 * @param {boolean} [compress]
		 * @returns {boolean} whether the publication has an eligible recipient
		 */
		publish(name, message, isBinary, compress) {
			assertOpen('publish');
			const topic = nativeTopic(name);
			const payload = framePayload(message, isBinary);
			if (!hadMembership) return false;
			const result = raw.publish(topic, payload, compress);
			if (result !== 0) return true;
			if (getServer === undefined) return false;
			const server = getServer();
			const peers = server.subscriberCount(topic) - Number(raw.isSubscribed(topic));
			if (peers <= 0) return false;
			// Bun requires the publisher to hold a native membership. A socket
			// that released every membership cannot receive a server broadcast; this fallback
			// preserves exclusion without changing any subscriptions.
			if (raw.subscriptions.length === 0) {
				return server.publish(topic, payload, compress) !== 0 || isEmptyPayload(payload);
			}
			// Zero bytes can still be a published empty frame. As with uWS,
			// true describes a publication, not delivery past backpressure.
			return isEmptyPayload(payload);
		},

		/**
		 * @param {string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView} topic
		 * @returns {boolean}
		 */
		subscribe(topic) {
			// Bun answers a closed subscribe with a boolean - true on 1.3, false
			// on 1.4 - and either one is an answer where the contract here is a
			// throw. The whole reason this facade exists; the closed check makes
			// the runtime's choice of boolean unobservable.
			assertOpen('subscribe');
			const subscribed = raw.subscribe(nativeTopic(topic));
			if (subscribed) hadMembership = true;
			return subscribed;
		},

		/**
		 * @param {string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView} topic
		 * @returns {boolean}
		 */
		unsubscribe(topic) {
			assertOpen('unsubscribe');
			return raw.unsubscribe(nativeTopic(topic));
		},

		/**
		 * Membership test. Does NOT throw on a closed socket, matching uWS: a
		 * closed socket is subscribed to nothing, and that is a meaningful
		 * answer rather than an error. Bun already returns false (probed).
		 *
		 * @param {string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView} topic
		 * @returns {boolean}
		 */
		isSubscribed(topic) {
			if (closed || raw.readyState !== OPEN) return false;
			return raw.isSubscribed(nativeTopic(topic));
		},

		/** @returns {number} bytes queued but not yet written */
		getBufferedAmount() {
			assertOpen('getBufferedAmount');
			return raw.getBufferedAmount();
		},

		/**
		 * Close with a close frame the client reads. uWS spells this `end`;
		 * Bun spells it `close`.
		 *
		 * The pair goes through the close rule (utils/close-frame.js) FIRST,
		 * whatever the socket's state: a code outside 1000-1003, 1007-1014 and
		 * 3000-4999 throws a TypeError, as does a reason with no code or one
		 * that is neither text nor UTF-8 bytes, and the connection stays open.
		 * A reason over 123 UTF-8 bytes is cut at a character boundary. No code
		 * at all sends a close frame with no status, which the peer reads as
		 * 1005 (and the server's own close hook reads 0, as on uWS). Then, like
		 * send and subscribe, it throws WsClosedError on a closed socket.
		 *
		 * @param {number} [code]
		 * @param {string | ArrayBufferView | ArrayBuffer} [reason]
		 */
		end(code, reason) {
			const sent = closeFrameReason(code, reason);
			assertOpen('end');
			if (code === undefined) {
				// The close handler runs inside raw.close, so the mark goes first.
				noStatusSent = true;
				try {
					raw.close(NO_STATUS_CLOSE_CODE);
				} catch {
					// A runtime that refuses the reserved code still closes, with
					// 1000 instead of an empty status; close-frame-check notices.
					raw.close();
				}
			} else if (sent === undefined) raw.close(code);
			else raw.close(code, sent);
		},

		/**
		 * Drop the connection with no close frame - the client reads 1006 and
		 * reconnects. uWS spells this `close`; Bun spells it `terminate`. Any
		 * arguments are ignored, as on uWS: the graceful close with a code is
		 * `end(code, reason)`.
		 *
		 * THE NAME CROSSES OVER, which is the trap: `end()` above is the
		 * graceful close and this is the hard cut, the opposite way round from
		 * Bun's own API.
		 */
		close() {
			assertOpen('close');
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

		/**
		 * Whether this side closed with end() and no code. uWS reports such a
		 * close to the server's own close handler as 0 (the peer reads 1005),
		 * and the close handler gives the hook the same.
		 * @internal
		 */
		get _noStatusSent() {
			return noStatusSent;
		},

		/** @returns {boolean} @internal test seam */
		get _closed() {
			return closed || raw.readyState !== OPEN;
		}
	};

	facades.set(raw, facade);
	return facade;
}

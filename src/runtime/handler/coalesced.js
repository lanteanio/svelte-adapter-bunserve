import { deliveryAuthorization } from './delivery-authorization.js';
/**
 * The per-connection queue behind `platform.sendCoalesced`: one pending value
 * per key, latest wins, flushed at once and again on every drain.
 *
 * In its own module because both the platform (which queues and flushes) and
 * the demux's drain handler (which resumes the flush) need it, and those two
 * already import each other.
 */

import { isNativeError } from 'node:util/types';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { ADAPTER_ERROR_IDS } from '../error-registry.js';
import { privateValueMetadata } from '../utils/observability-privacy.js';
import { setTimer } from '../runtime.js';
import { assert } from '../utils/assertions.js';
import { drainCoalesced } from '../utils/backpressure.js';
import { SEND_BACKPRESSURE, SEND_DROPPED } from '../utils/send-result.js';
import { WS_COALESCED, WS_PLATFORM, wsConnections, wsCounters } from './ws-state.js';
import { bumpOut } from './ws-stats.js';

const coalescedContinuations = new WeakSet();

/** Report a dropped entry with private identifier fields and bounded application error text. */
function reportCoalescedFailure(userData, msg, key, err) {
	try {
		emitOperationalEvent({
			source: 'svelte-adapter-bunserve',
			component: 'runtime.websocket',
			event: 'ws.send-coalesced.unserializable',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'A queued sendCoalesced value has no JSON form and was dropped.',
			attributes: {
				errorId: ADAPTER_ERROR_IDS.COALESCED_UNSERIALIZABLE,
				requestId: userData[WS_PLATFORM]?.requestId ?? null,
				key: privateValueMetadata(key, 'coalesced-key'),
				topic: privateValueMetadata(msg.topic, 'topic'),
				event: privateValueMetadata(msg.event, 'event'),
				error: diagnosticError(err)
			}
		});
	} catch { /* reporting must not escape drain */ }
}

/**
 * Drain any pending coalesce-by-key messages on one connection. Serializes
 * lazily: only the surviving (latest) value per key pays for JSON.
 *
 * A value JSON cannot carry (a BigInt, a cycle, a throwing `toJSON`, a
 * function) is dropped here and the rest of the queue still goes out. When the
 * value is the one the caller of `sendCoalesced` just set, the flush is running
 * inside that call, so the caller gets the native Error or a TypeError for
 * any other failure. Any other failing entry was queued earlier
 * and is being flushed from the drain callback, where a throw would escape
 * into Bun, so it is reported instead. Reporter failures are contained too.
 *
 * @param {any} ws - the socket facade
 * @param {object} [callerEntry] the entry the calling `sendCoalesced` just set
 */
export function flushCoalescedFor(ws, callerEntry) {
	let userData;
	try {
		userData = ws.getUserData();
	} catch {
		wsCounters.closedWsAborts++;
		return;
	}
	const pending = userData[WS_COALESCED];
	if (!pending || pending.size === 0) return;
	assert(pending instanceof Map, 'coalesce.pending-type', null);
	let aborted = false;
	/** @type {unknown} */
	let callerError = null;
	const deliveryOperation = deliveryAuthorization.begin();
	try {
		const yielded = drainCoalesced(pending, (/** @type {any} */ msg, key) => {
			if (aborted) return SEND_DROPPED;
			assert(typeof msg.topic === 'string', 'coalesce.entry-topic-type', null);
			assert(typeof msg.event === 'string', 'coalesce.entry-event-type', null);
			let payload;
			let failure;
			try {
				const body = JSON.stringify(msg.data ?? null);
				if (typeof body === 'string') payload = msg.prefix + body + '}';
			} catch (err) { failure = err; }
			// A serializer may have queued a newer value for this key.
			if (pending.get(key) !== msg) return 1;
			if (payload === undefined) {
				const err = isNativeError(failure) ? failure : new TypeError('sendCoalesced data has no JSON form');
				if (msg === callerEntry) callerError = err;
				else {
					reportCoalescedFailure(userData, msg, key, err);
				}
				return 1;
			}
			let result;
			try {
				result = deliveryAuthorization.armed
				? deliveryAuthorization.sendReplaceable(ws, payload)
				: ws.send(payload, false, false);
			} catch {
				// The socket closed mid-flush. No later drain will retry, so the
				// rest of the queue goes too: BACKPRESSURE removes this entry and
				// stops the loop, and the clear below takes the others.
				wsCounters.closedWsAborts++;
				aborted = true;
				return SEND_BACKPRESSURE;
			}
			// The send result goes back to drainCoalesced as it is: SUCCESS removes
			// the entry and continues, BACKPRESSURE (queued) removes it and stops,
			// DROPPED keeps it for the next drain.
			if (result !== SEND_DROPPED) bumpOut(ws, payload);
			return result;
		});
		if (aborted) pending.clear();
		else if (yielded && !coalescedContinuations.has(pending)) {
			coalescedContinuations.add(pending);
			setTimer(() => {
				coalescedContinuations.delete(pending);
				if (!wsConnections.has(ws)) { pending.clear(); return; }
				flushCoalescedFor(ws);
			}, 0);
		}
		if (callerError !== null) throw callerError;
	} finally { deliveryAuthorization.finish(deliveryOperation); }
}

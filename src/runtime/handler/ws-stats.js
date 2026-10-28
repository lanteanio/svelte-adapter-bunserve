/**
 * Per-connection traffic counters for the close hook.
 *
 * In its own module because BOTH the demux (handler/ws.js) and the platform
 * (handler/platform.js) have to charge their sends to it, and those two already
 * import each other. Keeping the counters here is what lets platform sends be
 * counted at all - while they were private to the demux, a close hook's
 * `bytesOut` reported only the adapter's own control frames and zero of the
 * application traffic the app actually cares about.
 *
 * The counters exist only when the app registered a close hook, since that is
 * the only thing that reads them; an app without one carries no per-connection
 * accounting at all.
 * Directed send, sendTo, sendWire, sendWireBatch and reconnect advisory frames
 * count when the socket accepts them, including queued backpressure.
 * Dropped and throwing sends count nothing.
 */

import { wsModule } from '../ws-handler-bridge.js';
import { WS_STATS } from './ws-state.js';

/** True when the app registered a close hook, which is what stats are for. */
export const closeHookRegistered = typeof wsModule.close === 'function';

/**
 * @param {any} ws
 * @returns {any} the connection's stats object, or null
 */
function statsFor(ws) {
	if (!closeHookRegistered) return null;
	try {
		return ws.getUserData()[WS_STATS] ?? null;
	} catch {
		return null;
	}
}

/**
 * Count one inbound frame.
 *
 * EXACT bytes, text included. svelte-adapter-uws counts the same thing: uWS
 * hands its message handler an ArrayBuffer for text and binary alike, so its
 * bytesIn is the byte count on the wire. Bun hands text over as a string, and
 * Buffer.byteLength gives that same figure back. Counting a string's `length`
 * here, as bumpOut does, would read non-ASCII inbound text differently on the
 * two adapters.
 *
 * @param {any} ws
 * @param {string | Uint8Array} message
 */
export function bumpIn(ws, message) {
	const stats = statsFor(ws);
	if (!stats) return;
	stats.messagesIn++;
	stats.bytesIn += typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
}

/**
 * Count one outbound frame, for the per-connection counters the close hook
 * reports.
 *
 * PER-SOCKET sends pair with this: the adapter's control frames and the
 * platform's directed sends alike. Live topic fan-out does NOT, on any lane: a
 * `platform.publish` hands one payload to `server.publish` and Bun writes it to
 * every subscriber itself, so there is no socket to charge, and the lanes that
 * do walk subscribers (`publishWire`, `publishWireBatch`) charge none either,
 * so a close hook reads the same figures whichever lane a broadcast took. Two
 * things such a publish can still charge, both per socket: the wire-id
 * announce a walk sends (a control frame), and the envelope held for a
 * connection whose resume is in progress, charged when the replay sends it -
 * as svelte-adapter-uws does.
 *
 * An app metering total egress has to account for its own publishes; these
 * counters answer "what did this connection cost me directly", not "what left
 * the process".
 *
 * Bytes for a binary frame, UTF-16 code units for a text one: an exact UTF-8
 * count would scan every frame on every send, and `length` is the unit
 * `topicPublishBytesPerSec` already uses. ASCII text counts the same either
 * way; non-ASCII text counts low. svelte-adapter-uws counts the same unit.
 * `bumpIn` stays exact; see there for why.
 *
 * @param {any} ws
 * @param {string | Uint8Array} payload
 */
export function bumpOut(ws, payload) {
	const stats = statsFor(ws);
	if (!stats) return;
	stats.messagesOut++;
	stats.bytesOut += typeof payload === 'string' ? payload.length : payload.byteLength;
}

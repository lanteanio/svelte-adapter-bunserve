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
 * Count one outbound frame. EVERY send site pairs with this - the adapter's own
 * control frames and the platform's application sends alike - so an app
 * metering egress or billing per byte sees the real number.
 *
 * @param {any} ws
 * @param {string | Uint8Array} payload
 */
export function bumpOut(ws, payload) {
	const stats = statsFor(ws);
	if (!stats) return;
	stats.messagesOut++;
	stats.bytesOut += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
}

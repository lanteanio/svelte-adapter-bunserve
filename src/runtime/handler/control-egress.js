// The one way a server-generated frame reaches a client OUTSIDE a publish.
//
// Everything sent here shares a property that ordinary fan-out does not have:
// the client asked for it. A subscribe buys an ack, a bad frame buys a refusal,
// a gap-fill that could not be completed buys a truncation marker. That makes
// the whole channel an amplifier - a few inbound bytes name a topic and are
// answered with a whole frame - so it is bounded per connection, in bytes over
// time, and a connection that blows the bound is cut rather than served.
//
// It lives in its own module because more than one sender needs it: handler/ws.js
// owns the ack and refusal frames, handler/resume-buffer.js owns the replay
// truncation marker, and resume-buffer is imported by platform.js, which ws.js
// imports in turn. Keeping the budgeted send in ws.js would have made the marker
// either uncharged or a cycle.

import { SEND_DROPPED } from '../utils/send-result.js';
import { CONTROL_FLOOD_CLOSE_CODE, controlFloodFrame } from '../utils/control-frame.js';
import { bumpOut } from './ws-stats.js';
import { MAX_CONTROL_EGRESS_BYTES, chargeControlEgress, wsCounters } from './ws-state.js';

/**
 * Send a control frame, charging a closed socket to the closed lane. Control
 * frames are never compressed: they are short, and deflating them costs more
 * than it saves.
 * @param {any} ws
 * @param {string} payload
 */
export function sendControl(ws, payload) {
	// Per-connection egress budget for the ACK CHANNEL. Per-entry acks are
	// what the family client needs (it keys denials and epochs off them, and
	// it re-subscribes everything as a batch on every reconnect), but they are
	// also unavoidably an amplifier: a short batch entry buys a whole frame,
	// and the entries that answer fastest cost the server nothing. The batch
	// size limit bounds the frame COUNT per inbound frame; this bounds the
	// bytes over time, which is the part a client can still drive by sending
	// many legal frames. Both are needed - see bench/control-egress.mjs, which
	// measures the worst-shaped legal frame as well as the ordinary one.
	if (!chargeControlEgress(ws, Buffer.byteLength(payload))) {
		refuseControlFlood(ws);
		return;
	}
	let result;
	try {
		result = ws.send(payload, false, false);
	} catch {
		wsCounters.closedWsAborts++;
		return;
	}
	// Only bytes that reached the wire, like platform.send. A frame refused
	// past the backpressure limit never went out.
	if (result !== SEND_DROPPED) bumpOut(ws, payload);
}

/**
 * Cut a connection that has blown its control-frame budget.
 *
 * Sent once and directly, bypassing the budget it just exhausted, so the client
 * learns why rather than seeing a bare close. See CONTROL_FLOOD_CLOSE_CODE for
 * why the cut is 4429 rather than 1008.
 *
 * @param {any} ws
 */
function refuseControlFlood(ws) {
	try {
		if (ws._controlFloodSignalled) return;
		ws._controlFloodSignalled = true;
		ws.send(controlFloodFrame(MAX_CONTROL_EGRESS_BYTES), false, false);
		ws.end(CONTROL_FLOOD_CLOSE_CODE, 'control frame budget exhausted');
	} catch {
		wsCounters.closedWsAborts++;
	}
}

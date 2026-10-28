// The budgeted sender for control frames: every frame a client's own input
// buys.
//
// Everything sent here shares a property that ordinary fan-out does not have:
// the client asked for it. A subscribe buys an ack, a bad frame buys a refusal,
// a gap-fill that could not be completed buys a truncation marker, a binary
// subscription buys the wire-id announce that precedes its first frame - even
// when that announce goes out from inside a publish walk. That makes
// the whole channel an amplifier - a few inbound bytes name a topic and are
// answered with a whole frame - so it is bounded per connection, in bytes over
// time, and a connection that blows the bound is cut rather than served.
//
// It lives in its own module because more than one sender needs it: handler/ws.js
// owns the ack and refusal frames, handler/resume-buffer.js owns the replay
// truncation marker, handler/wire-state.js and handler/cohort.js own the
// wire-id announces, and resume-buffer is imported by platform.js, which ws.js
// imports in turn. Keeping the budgeted send in ws.js would have made the
// marker either uncharged or a cycle.

import { SEND_DROPPED } from '../utils/send-result.js';
import { CONTROL_FLOOD_CLOSE_CODE } from '../utils/control-frame.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import { processMonotonicNow } from '../runtime.js';
import { bumpOut } from './ws-stats.js';
import {
	CONTROL_EGRESS_WINDOW_MS,
	MAX_CONTROL_EGRESS_BYTES,
	WS_PLATFORM,
	chargeControlEgress,
	wsCounters
} from './ws-state.js';

/**
 * The control frame reached the client - written to the socket, or queued
 * behind backpressure, which delivers in order.
 */
export const CONTROL_DELIVERED = 0;

/**
 * The socket refused it past its backpressure limit. The connection is still
 * open, and nothing on it was told.
 */
export const CONTROL_REFUSED = 1;

/**
 * There is no connection left to answer: the send threw, or the frame blew the
 * budget and the connection was cut. Nothing more may be sent on it, and it
 * must not be closed a second time.
 */
export const CONTROL_GONE = 2;

/**
 * Send a control frame, charging a closed socket to the closed lane. Control
 * frames are never compressed: they are short, and deflating them costs more
 * than it saves.
 *
 * The answer matters to one caller. Most senders here have nothing to do about
 * a frame the client did not get - a refused ack is re-driven by the client's
 * own retry - but the resume lane escalates on it: a truncation marker that
 * does not arrive is the difference between a client that cold-resyncs and one
 * that goes live believing it received a gap-fill it never got.
 *
 * @param {any} ws
 * @param {string} payload
 * @returns {0 | 1 | 2} one of CONTROL_DELIVERED, CONTROL_REFUSED, CONTROL_GONE
 */
export function sendControl(ws, payload) {
	// Per-connection egress budget for the ACK CHANNEL. Per-entry acks are
	// what the family client needs (it keys denials and epochs off them, and
	// it re-subscribes everything as a batch on every reconnect), but they are
	// also unavoidably an amplifier: a short batch entry buys a whole frame,
	// and overflow entries still receive per-entry denials. This bounds bytes
	// over time even when a single legal control frame buys thousands of
	// replies. See bench/control-egress.mjs for ordinary, overflow and maximal
	// ref shapes, as well as the observed cut at the budget.
	if (!chargeControlEgress(ws, Buffer.byteLength(payload))) {
		refuseControlFlood(ws);
		return CONTROL_GONE;
	}
	let result;
	try {
		result = ws.send(payload, false, false);
	} catch {
		wsCounters.closedWsAborts++;
		return CONTROL_GONE;
	}
	// Protocol control frames count only when accepted by the socket. A frame
	// refused past the backpressure limit is not charged by this helper.
	if (result === SEND_DROPPED) return CONTROL_REFUSED;
	bumpOut(ws, payload);
	return CONTROL_DELIVERED;
}

/**
 * Cut a connection that has blown its control-frame budget.
 *
 * NOTHING IS WRITTEN TO THE WIRE except the close. The protocol has no error
 * code for this, and an explanatory frame would be a wire change rather than
 * an additive one. It is not needed either: 4429 is the family client's
 * THROTTLE class (see CONTROL_FLOOD_CLOSE_CODE), so the client reconnects on
 * the accelerated curve without being told anything more. The party who needs
 * the detail is the operator, who gets a console line naming the connection's
 * request id.
 *
 * Guarded, because several senders can discover the same exhausted budget
 * inside one batch and the second must not close a closing connection or
 * report a second time.
 *
 * @param {any} ws
 */
function refuseControlFlood(ws) {
	try {
		if (ws._controlFloodSignalled) return;
		ws._controlFloodSignalled = true;
		// The operator line never costs the cut: with a console.warn that
		// throws, the guard above is already set, so skipping the close here
		// would leave the connection open for good.
		try {
			warnControlFlood(ws);
		} catch {
			// The close below is what matters.
		}
		ws.end(CONTROL_FLOOD_CLOSE_CODE, 'control frame budget exhausted');
	} catch {
		wsCounters.closedWsAborts++;
	}
}

/**
 * Throttled with decay, because a client drives it: one connection cut per
 * line would let a reconnecting flood bury every other warning.
 */
const controlFloodThrottle = createLogThrottle(() => processMonotonicNow());

/** @param {any} ws */
function warnControlFlood(ws) {
	const { log: logIt, count: n } = controlFloodThrottle();
	if (!logIt) return;
	let requestId = null;
	try {
		// The open handler moves the upgrade's request id onto the
		// connection's platform clone and deletes the carry slot.
		requestId = ws.getUserData()[WS_PLATFORM]?.requestId ?? null;
	} catch {
		// Already torn down; the line still says what happened.
	}
	const suffix = n > 1 ? ` (occurrence ${n})` : '';
	console.warn(
		`[ws] closed a connection 4429 for exhausting its control-frame budget${suffix}: request ` +
		`${requestId === null ? '(unknown)' : requestId}, limit ${MAX_CONTROL_EGRESS_BYTES} bytes per ` +
		`${CONTROL_EGRESS_WINDOW_MS / 1000} s.\n` +
		'  Acks, resume markers and wire-id announces the client\'s own frames bought came to more than\n' +
		'  that. A client restoring tens of thousands of topics at once can reach it legitimately.'
	);
}

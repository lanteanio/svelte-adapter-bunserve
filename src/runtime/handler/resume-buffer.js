// Live-frame buffering for the replay-to-live cutover. When a connection
// gap-fills a topic on subscribe (a recover offset), the server reads the
// backend, then subscribes the client to live. Between those two steps an
// ASYNC resume hook yields the event loop, so a publish landing in that
// window is past the backend read but not yet on the live membership - the
// client would never see it, a silent gap. The barrier here holds those live
// frames: a buffer is opened BEFORE the resume await, every fan-out site
// appends to it during the window, and once live membership is installed the
// held frames are flushed in order (deduped against what the resume already
// covered) before the ack.
//
// A synchronous (in-memory) resume never yields a macrotask, so nothing is
// captured and the flush is a no-op - identical to the barrier-less behavior.
// The window only ever holds frames behind a network-backed resume.

import { ws_compression_on } from './config.js';
import { SEND_DROPPED } from '../utils/send-result.js';
import { bumpOut } from './ws-stats.js';
import { maxSeenSeq, resumeBuffers, wsCounters } from './ws-state.js';

/**
 * @typedef {{ topic: string, buffer: { ws: any, frames: { seq: number | null, envelope: string, compress: boolean, authoritative: boolean }[], overflow: boolean }, before: number }} ResumeCaptureEntry
 * @typedef {{ ws: any, entries: ResumeCaptureEntry[] }} ResumeCaptureHandle
 */

/**
 * Open a live-frame buffer for each topic about to be resumed, BEFORE the
 * resume await. Records each topic's current max-seen seq as the fallback
 * dedup floor (used when the resume hook does not report the watermark it
 * covered).
 *
 * @param {string[]} topics
 * @param {any} ws - the socket facade
 * @returns {ResumeCaptureHandle}
 */
export function beginResumeCapture(topics, ws) {
	/** @type {ResumeCaptureEntry[]} */
	const entries = [];
	for (const topic of topics) {
		// The buffer carries its owning socket so captureResumeFrame can skip
		// it for a publish that excluded exactly this connection.
		const buffer = { ws, frames: [], overflow: false };
		let set = resumeBuffers.get(topic);
		if (set === undefined) {
			set = new Set();
			resumeBuffers.set(topic, set);
		}
		set.add(buffer);
		const before = maxSeenSeq.get(topic);
		entries.push({ topic, buffer, before: typeof before === 'number' ? before : 0 });
	}
	return { ws, entries };
}

/**
 * @param {ResumeCaptureHandle} handle
 * @param {ResumeCaptureEntry} entry
 */
function unregister(handle, entry) {
	const set = resumeBuffers.get(entry.topic);
	if (set === undefined) return;
	set.delete(entry.buffer);
	if (set.size === 0) resumeBuffers.delete(entry.topic);
}

/**
 * Close every buffer in the handle WITHOUT delivering anything. Used on the
 * paths where the subscription does not land after all (denied, cancelled,
 * closed) and on the race where a concurrent subscribe already installed the
 * topic, so the client is live and the buffered frames would be duplicates.
 *
 * @param {ResumeCaptureHandle} handle
 */
export function discardResumeCapture(handle) {
	for (const entry of handle.entries) unregister(handle, entry);
	handle.entries.length = 0;
}

/**
 * Tell the client this topic's gap-fill is incomplete, on the replay channel -
 * the same marker a replay backend emits for an uncoverable range. The client
 * drops its stale per-topic offset and cold-resyncs.
 *
 * Best effort by nature: a socket already past its backpressure limit refuses
 * this frame too. It gets through for a transient or borderline drop, which is
 * the common case, and costs one short frame when it does not.
 *
 * @param {any} ws
 * @param {string} topic
 */
function sendTruncated(ws, topic) {
	const marker =
		'{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"truncated","data":null}';
	let result;
	try {
		result = ws.send(marker, false, false);
	} catch {
		wsCounters.closedWsAborts++;
		return;
	}
	// Only bytes that reached the wire, like every other send site.
	if (result !== SEND_DROPPED) bumpOut(ws, marker);
}

/**
 * Flush the frames held for one topic to the connection, in capture (seq)
 * order, skipping any the resume already covered, then close the buffer.
 * `coveredSeq` is the highest seq the resume hook reported delivering for
 * this topic; when it is not a number the entry's pre-window max-seen seq is
 * the conservative floor. A cooperating backend reports the exact watermark
 * so the boundary is exact; a non-reporting one may re-deliver the small
 * window between buffer-open and the backend read, which the client
 * tolerates far better than a gap.
 *
 * @param {ResumeCaptureHandle} handle
 * @param {string} topic
 * @param {number | undefined} coveredSeq
 */
export function flushResumeTopic(handle, topic, coveredSeq) {
	const entry = handle.entries.find((e) => e.topic === topic);
	if (entry === undefined) return;
	const ws = handle.ws;
	if (entry.buffer.overflow) {
		// The window overflowed the frame cap: the tail past the cap was
		// never captured, and the client has no gap detection, so trusting a
		// partial flush would leave a silent hole. Signal the truncation on
		// the replay channel FIRST - the same marker a replay backend emits
		// for an uncoverable range - so this critical resync signal is not
		// itself lost behind the backpressure the partial flush below would
		// build. The client drops its stale per-topic offset and
		// cold-resyncs; the partial frames are then a best-effort extra.
		sendTruncated(ws, topic);
	}
	// The dedup floor. A reported watermark is trusted only up to what this
	// server has actually stamped for the topic: the floor is the hook's RETURN,
	// echoing the client's own offset back is the natural hook shape, and the
	// client controls that value - so without a bound an absurd offset becomes a
	// floor that discards the entire held window.
	//
	// The ceiling is the HIGHER of the topic's mark now and its mark at window
	// open, because the live mark can move DOWN: noteMaxSeen applies its monotone
	// guard only to explicit seqs, so a `{ seq: true }` publish overwrites it
	// unconditionally, and LRU eviction can re-seed it low. A ceiling below
	// `entry.before` would make the fallback HIGHER than the value it rejected,
	// dropping in-window frames the hook never covered - the precise failure this
	// bound exists to prevent. Comparison rather than Math.max: a NaN mark must
	// not become the ceiling, because nothing is ever `>` NaN and every reported
	// value would then be trusted, including the client echo this guards.
	//
	// The fallback is the pre-window mark - the same floor a hook that reports
	// nothing gets. Conservative, NOT lossless: a frame captured BELOW that mark,
	// which a reordered explicit seq can be, is still deduped away. Bounding in
	// the authoritative seq space would close that class; the mark is currently
	// written by both lanes.
	//
	// A NaN coveredSeq is deliberately NOT screened out: `NaN > ceiling` is
	// false, so it arrives below as a floor nothing is ever `<=` and every held
	// frame flushes. A hook that reported nonsense has said nothing about what it
	// covered.
	const seen = maxSeenSeq.get(topic);
	const ceiling = typeof seen === 'number' && seen > entry.before ? seen : entry.before;
	const floor =
		coveredSeq === undefined || coveredSeq > ceiling ? entry.before : coveredSeq;
	let dropped = false;
	for (const f of entry.buffer.frames) {
		// Dedup ONLY explicit-seq frames against the floor: they share the
		// floor's seq space. A counter-stamped live frame is always newer than
		// the window, so comparing it to an explicit floor could only ever
		// drop it wrongly - it always flushes.
		if (f.authoritative && f.seq !== null && f.seq <= floor) continue;
		const compress = ws_compression_on && f.compress;
		let result;
		try {
			result = ws.send(f.envelope, false, compress);
		} catch {
			wsCounters.closedWsAborts++;
			break;
		}
		if (result === SEND_DROPPED) {
			// A refused gap-fill frame is the same silent hole the overflow
			// branch guards against: the ack that follows tells the client to
			// go live, with this frame missing and nothing to make it notice.
			// Stop pushing frames the socket is refusing, and signal.
			dropped = true;
			break;
		}
		bumpOut(ws, f.envelope);
	}
	// Not when the window already overflowed - that path signalled up front.
	if (dropped && !entry.buffer.overflow) sendTruncated(ws, topic);
	unregister(handle, entry);
	// Drop the entry from the handle too, so a repeat flush for this topic is
	// a no-op and a final-sweep discard only touches un-flushed topics.
	const ei = handle.entries.indexOf(entry);
	if (ei !== -1) handle.entries.splice(ei, 1);
}

/**
 * Normalize the value a `resume` hook returns into the highest seq it
 * delivered for `topic`, or `undefined` when it reported nothing (the flush
 * then falls back to the pre-window floor). Accepts a per-topic map
 * `{ [topic]: seq }` or, for single-topic callers, a bare number.
 *
 * @param {unknown} covered
 * @param {string} topic
 * @returns {number | undefined}
 */
export function coveredSeqFor(covered, topic) {
	if (covered == null) return undefined;
	if (typeof covered === 'number') return covered;
	if (typeof covered === 'object') {
		// `covered` is whatever the app's resume hook returned, so this
		// property read can throw - a getter, a Proxy, a lazy ORM row. A hook
		// result that cannot be read is treated as covering nothing, which is
		// the same answer a hook returning a non-number gives.
		try {
			const v = /** @type {Record<string, unknown>} */ (covered)[topic];
			// Passed through as reported, including a nonsense magnitude: whether
			// a reported value is USABLE as a dedup floor is decided in
			// flushResumeTopic, against what this server has actually stamped.
			// Deciding it here cannot work - the answer depends on the topic's
			// high-water mark, which this pure helper does not see.
			return typeof v === 'number' ? v : undefined;
		} catch (err) {
			console.error('[ws] resume hook result read threw for topic', topic, err);
			return undefined;
		}
	}
	return undefined;
}

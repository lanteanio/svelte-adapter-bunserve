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
import { bumpOut } from './ws-stats.js';
import { maxSeenSeq, resumeBuffers, wsCounters } from './ws-state.js';

/**
 * @typedef {{ topic: string, buffer: { frames: { seq: number | null, envelope: string, compress: boolean }[], overflow: boolean }, before: number }} ResumeCaptureEntry
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
		const marker =
			'{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"truncated","data":null}';
		try {
			ws.send(marker, false, false);
			bumpOut(ws, marker);
		} catch {
			wsCounters.closedWsAborts++;
		}
	}
	const floor = typeof coveredSeq === 'number' ? coveredSeq : entry.before;
	for (const f of entry.buffer.frames) {
		// Dedup ONLY explicit-seq frames against the floor: they share the
		// floor's seq space. A counter-stamped live frame is always newer than
		// the window, so comparing it to an explicit floor could only ever
		// drop it wrongly - it always flushes.
		if (f.authoritative && f.seq !== null && f.seq <= floor) continue;
		const compress = ws_compression_on && f.compress;
		try {
			ws.send(f.envelope, false, compress);
		} catch {
			wsCounters.closedWsAborts++;
			break;
		}
		bumpOut(ws, f.envelope);
	}
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
			return typeof v === 'number' ? v : undefined;
		} catch (err) {
			console.error('[ws] resume hook result read threw for topic', topic, err);
			return undefined;
		}
	}
	return undefined;
}

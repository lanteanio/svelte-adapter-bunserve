import { PayloadTooLargeError } from './runtime/handler/testing-http-helpers.js';
import { setTimer, clearTimer, setImmediateTimer, clearImmediateTimer } from './runtime/runtime.js';

// An answer held for the rest of its body is bounded as production bounds it:
// the rest has to arrive at 16 KiB/s or more, measured over each period, and a
// period that falls short ends the wait and the connection with it.
const BODY_WAIT_LIMIT_MS = 10000;
const BODY_WAIT_BYTES = 16 * 1024 * (BODY_WAIT_LIMIT_MS / 1000);

/** @param {any} timer */
const unref = (timer) => {
	if (typeof timer?.unref === 'function') timer.unref();
	return timer;
};

/**
 * The auth endpoint's request body under a byte budget, settled the way
 * production settles it before each answer.
 *
 * Node owns these chunks beyond its callback, so the Request can consume them
 * directly. Reads pause between pulls. Every byte that arrives counts toward
 * the budget, including the ones discarded once nothing reads the body, and
 * the first byte past it calls `refuse`, which answers 413 and closes the
 * connection.
 *
 * `answer(canClose)` settles the body for the answer about to be written. A
 * complete body answers at once and keeps the connection. Otherwise the
 * answer waits for the rest to arrive and be discarded (or read, by a reader
 * that keeps up), bounded by the pace above; a body of undeclared length that
 * nothing reads closes the connection behind an answer that can carry the
 * close instead, after the read in progress, which can complete it. An answer
 * that cannot carry the close (the implicit 204) always waits, and a rest that
 * stalls closes the connection without it.
 *
 * @param {import('node:http').IncomingMessage | import('node:http2').Http2ServerRequest} req
 * @param {number} limit
 * @param {{ declared: boolean, refuse: () => void, close: () => void }} hooks -
 *   `declared`: the request states its length; `refuse`: answer the budget
 *   overrun; `close`: drop the connection with no answer
 */
export function authRequestBody(req, limit, { declared, refuse, close }) {
	/** @type {ReadableStreamDefaultController<Uint8Array>} */
	let controller;
	let total = 0;
	let settled = false;    // the stream takes no more bytes
	let complete = false;   // the last byte arrived
	let refused = false;    // the budget was exceeded
	let answering = false;  // a reader holds the body while an answer waits
	let finalized = false;
	/** @type {boolean | null} */
	let closing = false;
	/** @type {((close: boolean | null) => void) | null} */
	let waiting = null;
	let canCloseHeld = true;
	/** @type {any} */
	let waitTimer = null;
	let waitBytes = 0;
	/** @type {any} */
	let passCheck = null;
	/** @type {any} */
	let keepUpCheck = null;

	const detach = () => {
		req.off('data', onData);
		req.off('end', onEnd);
		req.off('aborted', onAborted);
		req.off('error', onError);
	};
	/** @param {Error} [error] */
	const settle = (error) => {
		if (settled) return;
		settled = true;
		if (keepUpCheck !== null) { clearImmediateTimer(keepUpCheck); keepUpCheck = null; }
		if (error) controller.error(error);
		else controller.close();
		// Discarded from here on, never retained.
		req.resume();
	};
	/** @param {boolean | null} decision */
	const finish = (decision) => {
		finalized = true;
		closing = decision;
	};
	/** @param {boolean | null} decision */
	const endWait = (decision) => {
		const resolve = /** @type {(close: boolean | null) => void} */ (waiting);
		waiting = null;
		if (passCheck !== null) { clearImmediateTimer(passCheck); passCheck = null; }
		if (waitTimer !== null) { clearTimer(waitTimer); waitTimer = null; }
		finish(decision);
		resolve(decision);
	};
	const armWait = () => {
		if (waitTimer !== null) clearTimer(waitTimer);
		waitBytes = 0;
		waitTimer = unref(setTimer(onWaitLimit, BODY_WAIT_LIMIT_MS));
	};
	const onWaitLimit = () => {
		waitTimer = null;
		if (waiting === null) return;
		settle(new Error('Request body not read'));
		if (canCloseHeld) {
			endWait(true);
			return;
		}
		detach();
		endWait(null);
		close();
	};
	const closeAfterRead = () => {
		if (passCheck !== null) return;
		passCheck = unref(setImmediateTimer(() => {
			passCheck = null;
			if (waiting !== null) endWait(true);
		}));
	};
	// A reader holding the body while its answer waits has to keep up: a queue
	// still unread once this read pass is over fails the body, and the answer
	// waits for the rest to be discarded instead.
	const checkKeepsUp = () => {
		if (keepUpCheck !== null) return;
		keepUpCheck = setImmediateTimer(() => {
			keepUpCheck = null;
			if (!settled && (controller.desiredSize ?? 0) < 0) settle(new Error('Request body not read'));
		});
	};
	const onEnd = () => {
		complete = true;
		detach();
		if (!settled) {
			settled = true;
			controller.close();
		}
		if (waiting !== null) endWait(false);
	};
	/** @param {Error} error */
	const onGone = (error) => {
		detach();
		settle(error);
		if (waiting !== null) endWait(null);
		else if (!finalized) finish(null);
	};
	const onAborted = () => onGone(new Error('Request aborted'));
	/** @param {Error} error */
	const onError = (error) => onGone(error);
	/** @param {Buffer} chunk */
	const onData = (chunk) => {
		total += chunk.byteLength;
		if (total > limit) {
			refused = true;
			detach();
			settle(new PayloadTooLargeError());
			if (waiting !== null) endWait(null);
			else finish(null);
			refuse();
			return;
		}
		if (waitTimer !== null && (waitBytes += chunk.byteLength) >= BODY_WAIT_BYTES) armWait();
		if (settled) return;
		controller.enqueue(chunk);
		if (answering) checkKeepsUp();
		else if ((controller.desiredSize ?? 0) <= 0) req.pause();
	};
	const body = new ReadableStream({
		start(value) {
			controller = value;
			req.pause();
			req.on('data', onData);
			req.once('end', onEnd);
			req.once('aborted', onAborted);
			req.once('error', onError);
			if (req.aborted) onAborted();
			else if (req.readableEnded) onEnd();
		},
		pull() { if (!settled) req.resume(); },
		cancel() {
			// Discard, not retain, what still arrives; it still counts.
			settled = true;
			req.resume();
			if (waiting !== null && canCloseHeld && !declared) closeAfterRead();
		}
	}, { highWaterMark: 0 });

	return {
		body,
		/** Whether the budget was exceeded, and `refuse` called for it. */
		get refused() { return refused; },
		/**
		 * Settle the body for the final answer about to be written.
		 *
		 * @param {boolean} [canClose] - that answer can carry Connection: close
		 * @returns {false | Promise<boolean | null>} false: write it and keep
		 *   the connection. Otherwise a promise for the decision: null when the
		 *   answer must not be written, else whether it closes the connection.
		 */
		answer(canClose = true) {
			// Asked again, as a failure path does after a throw: the same
			// decision, and never a second write behind an answer still held.
			if (finalized) return closing === false ? false : Promise.resolve(closing);
			if (waiting !== null) return Promise.resolve(null);
			if (complete) {
				finish(false);
				return false;
			}
			const locked = !settled && body.locked;
			if (locked) {
				answering = true;
				req.resume();
				if ((controller.desiredSize ?? 0) < 0) checkKeepsUp();
			} else {
				settle(new Error('Request completed'));
			}
			return new Promise((resolve) => {
				waiting = resolve;
				canCloseHeld = canClose;
				armWait();
				if (!locked && canClose && !declared) closeAfterRead();
			});
		},
		/** Stop counting once the answer is written; what still arrives is drained. */
		release() {
			if (waiting !== null) endWait(null);
			if (waitTimer !== null) { clearTimer(waitTimer); waitTimer = null; }
			if (keepUpCheck !== null) { clearImmediateTimer(keepUpCheck); keepUpCheck = null; }
			detach();
			req.resume();
		}
	};
}

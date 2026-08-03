/**
 * A bounded per-connection queue for app hooks a client can drive.
 *
 * The `unsubscribe` hook is the one that needs this, and the reason is Bun's
 * dispatch shape: the `message` handler is not awaited, so everything a frame
 * does before its first suspension happens synchronously, and a client can
 * pipeline thousands of frames in one read burst. Bounding the CALLS with a
 * counter - the shape the subscribe gate uses - only works when exceeding the
 * bound is allowed to REFUSE. The unsubscribe hook cannot be refused: it is
 * where the app releases plugin state (a presence roster entry, a cursor
 * attachment) that outlives native membership, and dropping it leaks that entry
 * until the socket closes, silently, because the family client sends
 * `unsubscribe` with no `ref` and has no branch for a refusal frame.
 *
 * So the work is DEFERRED rather than refused: at most `concurrency` hooks run
 * at once and the rest wait in FIFO order. Two tiers, because the two lanes have
 * different rights - see `enqueue`.
 *
 * Pure and socket-free so the bound is testable without a server.
 */

/**
 * @typedef {object} HookQueue
 * @property {(task: () => unknown, required: boolean) => 'ran' | 'queued' | 'refused' | 'overflow'} enqueue
 * @property {() => number} running
 * @property {() => number} queued
 * @property {() => void} clear
 */

/**
 * @param {object} options
 * @param {number} options.concurrency - hooks allowed to run at once
 * @param {number} options.maxQueued - tasks allowed to wait
 * @returns {HookQueue}
 */
import { microtask } from '../runtime.js';

export function createHookQueue({ concurrency, maxQueued }) {
	let running = 0;
	/** @type {Array<() => unknown>} */
	let queue = [];
	let cleared = false;

	function pump() {
		while (running < concurrency && queue.length > 0) {
			const next = /** @type {() => unknown} */ (queue.shift());
			start(next);
		}
	}

	/** @param {() => unknown} task */
	function start(task) {
		running++;
		let settled;
		try {
			settled = task();
		} catch {
			// A hook that throws synchronously must not take the queue down with
			// it, and must not strand the slot. The caller has already wrapped the
			// hook for logging; here it is only a slot to release.
			running--;
			microtask(pump);
			return;
		}
		Promise.resolve(settled)
			.catch(() => {})
			.finally(() => {
				running--;
				if (!cleared) pump();
			});
	}

	return {
		/**
		 * `required` marks a task whose work cannot be dropped without leaking
		 * app state. It may wait, but it is never refused while there is queue
		 * space; a speculative task (a release for a topic this connection was
		 * never granted, which costs an attacker nothing to invent) yields the
		 * queue to it.
		 *
		 * `overflow` means even a required task found no space. The caller is
		 * expected to close the connection rather than drop it: the close path
		 * runs the app's `close` hook with the full subscription snapshot, which
		 * is the same teardown by another route, so the state is released rather
		 * than leaked.
		 *
		 * @param {() => unknown} task
		 * @param {boolean} required
		 * @returns {'ran' | 'queued' | 'refused' | 'overflow'}
		 */
		enqueue(task, required) {
			if (cleared) return 'refused';
			if (running < concurrency) {
				start(task);
				return 'ran';
			}
			// Speculative work yields as soon as anything is waiting: it exists to
			// cover plugin state that MIGHT be attached, and the queue being busy
			// is exactly when the connection is being driven hard enough that a
			// speculative hook is the least valuable thing in it.
			if (!required) return 'refused';
			if (queue.length >= maxQueued) return 'overflow';
			queue.push(task);
			return 'queued';
		},
		running: () => running,
		queued: () => queue.length,
		/**
		 * Drop everything waiting. Called when the connection closes: the `close`
		 * hook receives the subscription snapshot and performs the same teardown,
		 * so running a queue of per-topic releases against a dead socket
		 * afterwards would be duplicate work at best.
		 */
		clear() {
			cleared = true;
			queue = [];
		}
	};
}

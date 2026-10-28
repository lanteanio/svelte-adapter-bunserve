import { setTimer, clearTimer, setIntervalTimer, clearIntervalTimer, wallEpoch, monotonicNow } from '../runtime.js';

/** One budget shared by the shutdown hook, drain and cleanup listeners. */
export function shutdownBudget(seconds) {
	const bounded = seconds > 0;
	const controller = new AbortController();
	const signal = bounded ? controller.signal : null;
	const deadline = bounded ? wallEpoch() + seconds * 1000 : null;
	const expiresAt = monotonicNow() + seconds * 1000;
	let timer;
	const expire = () => {
		const remaining = expiresAt - monotonicNow();
		if (remaining <= 0) controller.abort();
		else timer = setTimer(expire, Math.min(remaining, 2147483647));
	};
	// Chunk long budgets to avoid the runtime's timer overflow behavior.
	// An interval keeps unlimited shutdowns alive for as long as they take.
	timer = bounded
		? setTimer(expire, Math.min(seconds * 1000, 2147483647))
		: setIntervalTimer(() => {}, 2147483647);
	return {
		signal,
		deadline,
		clear: () => bounded ? clearTimer(timer) : clearIntervalTimer(timer),
		async wait(work) {
			if (!signal) { await work; return true; }
			if (signal.aborted) { Promise.resolve(work).catch(() => {}); return false; }
			let abort;
			try {
				return await Promise.race([
					Promise.resolve(work).then(() => true),
					new Promise((resolve) => {
						abort = () => resolve(false);
						signal.addEventListener('abort', abort, { once: true });
					})
				]);
			} finally {
				if (abort) signal.removeEventListener('abort', abort);
			}
		}
	};
}

/** Await process cleanup after requests finish; contain each listener's failure. */
export async function runShutdownCleanup(reason, budget, emitter = process) {
	let succeeded = true;
	const pending = emitter.rawListeners('sveltekit:shutdown').map(async (listener) => {
		try {
			await listener.call(emitter, reason, { reason, signal: budget.signal, deadline: budget.deadline });
		} catch (err) {
			succeeded = false;
			console.error('[shutdown] a cleanup listener failed:', err);
		}
	});
	return await budget.wait(Promise.all(pending)) && succeeded;
}

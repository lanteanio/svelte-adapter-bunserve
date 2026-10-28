// The exception boundary around the app's `open`, `message`, `drain` and
// `close` hooks: a bug in one connection's hook costs that connection, never
// the worker or the other connections on it.
//
// Bun calls the WebSocket handlers from its own callbacks and never awaits
// what they return, so a hook's throw or rejection that escaped here would be
// an uncaught exception or an unhandled rejection. Contained, it is answered
// the way svelte-adapter-uws answers it: an `open`, `message` or `drain` hook
// that throws or rejects has its connection closed with 1011 and a reason
// that names the hook (the cause stays server-side), and a failing `close`
// hook is only logged, since its connection is already gone. The line printed
// is the one the other adapter prints, id included, so a log search finds both.

const LINES = Object.freeze({
	message: '[ws] the message hook threw [ADAPTER-ERR-MESSAGE-HOOK]',
	open: '[ws] the open hook threw [ADAPTER-ERR-OPEN-HOOK]',
	drain: '[ws] the drain hook threw [ADAPTER-ERR-DRAIN-HOOK]',
	close: '[ws] the close hook threw [ADAPTER-ERR-CLOSE-HOOK]'
});

/**
 * Report a failed hook and close its connection with 1011 when it has one
 * left to close. Unthrottled: every failure costs a connection, so the line
 * rate is bounded by how fast connections open.
 *
 * @param {keyof typeof LINES} name
 * @param {any} ws
 * @param {string | null} closeReason
 * @param {unknown} err
 */
function hookFailed(name, ws, closeReason, err) {
	// The line never costs the close: a console.error that throws would
	// otherwise leave the connection open and carry the throw out of the
	// boundary that exists to stop it.
	try {
		console.error(LINES[name], err);
	} catch {
		// The close below is what matters.
	}
	if (closeReason === null) return;
	try {
		ws.end(1011, closeReason);
	} catch {
		// Already closed, by the hook itself or by the client.
	}
}

/**
 * Call `handlers[name]` as a method of the object that holds it and contain
 * a synchronous throw and a rejection alike. Not awaited by the caller: an
 * async `open` has never held back the connection's first message. The `then`
 * read and attach sit inside the same try as the call, because a returned
 * value whose `then` throws would otherwise leave through the seam the catch
 * is here to close. An export that reaches here set but not a function is
 * still called, so its TypeError is reported for every connection rather than
 * skipped in silence; ws.js passes `open` and `drain` only when truthy, as
 * svelte-adapter-uws does, so a falsy one is a hook switched off.
 *
 * @param {any} handlers - the object holding the app hooks
 * @param {keyof typeof LINES} name
 * @param {any} ws
 * @param {any} context
 * @param {string | null} closeReason - null for a hook whose connection is gone
 * @returns {Promise<void> | undefined} the guarded settle of an async hook
 */
function runLifecycleHook(handlers, name, ws, context, closeReason, onError) {
	if (handlers?.[name] == null) return undefined;
	try {
		const result = handlers[name](ws, context);
		if (result != null && typeof result.then === 'function') {
			return Promise.resolve(
				result.then(ignoreFulfilled, (/** @type {unknown} */ err) => { onError?.(); hookFailed(name, ws, closeReason, err); })
			);
		}
	} catch (err) {
		onError?.();
		hookFailed(name, ws, closeReason, err);
	}
	return undefined;
}

function ignoreFulfilled() {}

/**
 * The `message` hook. A throw or rejection closes the connection with 1011.
 * An export that is not a function is not a message hook, and is skipped.
 *
 * @param {any} handlers
 * @param {any} ws
 * @param {any} context
 * @returns {Promise<void> | undefined}
 */
export function runMessageHook(handlers, ws, context, onError) {
	if (typeof handlers?.message !== 'function') return undefined;
	return runLifecycleHook(handlers, 'message', ws, context, 'Message handler error', onError);
}

/**
 * The `open` hook. A throw or rejection closes the connection with 1011, and
 * the `close` hook then runs for it as for any other close.
 *
 * @param {any} handlers
 * @param {any} ws
 * @param {any} context
 */
export function runOpenHook(handlers, ws, context) {
	runLifecycleHook(handlers, 'open', ws, context, 'Open handler error');
}

/**
 * The `drain` hook. A throw or rejection closes the connection with 1011.
 *
 * @param {any} handlers
 * @param {any} ws
 * @param {any} context
 */
export function runDrainHook(handlers, ws, context) {
	runLifecycleHook(handlers, 'drain', ws, context, 'Drain handler error');
}

/**
 * The `close` hook. A throw or rejection is logged and nothing else: the
 * connection is already gone, and the teardown after the hook must still run.
 * Returns the guarded settle of an async hook, so the shutdown drain can wait
 * for close hooks to finish before the process exits.
 *
 * @param {any} handlers
 * @param {any} ws
 * @param {any} context
 * @returns {Promise<void> | undefined}
 */
export function runCloseHook(handlers, ws, context) {
	return runLifecycleHook(handlers, 'close', ws, context, null);
}

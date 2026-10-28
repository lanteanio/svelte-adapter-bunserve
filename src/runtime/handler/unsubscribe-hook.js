/** Contained application teardown for wire and server revocations. */

import { processMonotonicNow } from '../runtime.js';
import { createLogThrottle } from '../utils/log-throttle.js';
import { runUnsubscribeHook } from '../utils/unsubscribe-hook.js';
import { wsModule } from '../ws-handler-bridge.js';
import { WS_PLATFORM } from './ws-state.js';

const hookErrorThrottles = new Map();

/**
 * @param {string} name
 * @param {unknown} err
 */
export function reportHookError(name, err) {
	// Throttled: a hook that throws on client-shaped input throws on every
	// frame, and a client can loop that frame. See utils/log-throttle.js.
	let throttle = hookErrorThrottles.get(name);
	if (!throttle) {
		throttle = createLogThrottle(() => processMonotonicNow());
		hookErrorThrottles.set(name, throttle);
	}
	const { log, count } = throttle();
	if (!log) return;
	const suffix = count > 1 ? ` (occurrence ${count})` : '';
	console.error(`[ws] the ${name} hook threw; the connection was left open${suffix}:`, err);
}

/** Invoke every release without waiting for application promises. */
export function dispatchUnsubscribeHook(ws, topic, _wasHeld, ud) {
	if (ud === undefined) {
		try { ud = ws.getUserData(); } catch { return false; }
	}
	runUnsubscribeHook(wsModule.unsubscribe, ws, topic, { platform: ud[WS_PLATFORM] });
	return false;
}

export const dispatchServerUnsubscribeHook = dispatchUnsubscribeHook;

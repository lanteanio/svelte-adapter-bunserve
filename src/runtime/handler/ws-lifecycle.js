/**
 * The app's process-lifetime WebSocket hooks: `init` at boot and `shutdown` at
 * graceful stop.
 *
 * These are how a framework arms itself against the platform - the family's
 * contract is `init({ platform })`, and a framework that relies on it to wire
 * its own state was simply never called on this adapter, silently. They are
 * separate from the per-connection hooks in handler/ws.js because they run
 * exactly once and are awaited, where a per-connection hook is fire-and-forget.
 *
 * Registered even when the app exports no WebSocket handler at all, because
 * `init` is also where an app sets up things the SSR path uses (the platform is
 * on the request too) - but the whole module is inert when there is no handler
 * module, which is what keeps the no-WebSocket build free of it.
 */

import { platform } from './platform.js';
import { wsModule } from '../ws-handler-bridge.js';

/**
 * Run one lifecycle hook if the app exported it.
 *
 * Throws are handled ASYMMETRICALLY, matching the family:
 *
 * - `init` RE-THROWS. Boot failure should be loud. A framework whose `init`
 *   cannot reach Redis has not armed itself, and continuing means serving
 *   traffic with a half-configured realtime surface whose only symptom is one
 *   stderr line - the orchestrator should see a dead container and retry.
 * - `shutdown` swallows. The process is already going away and the remaining
 *   shutdown steps still have to run.
 *
 * `workerData` is part of the family's `init` context and is passed as `null`
 * here: this adapter is single-process by design, so there is never a worker
 * payload, and `null` says "no worker" where `undefined` would read as "this
 * adapter does not implement the field".
 *
 * @param {'init' | 'shutdown'} name
 * @returns {Promise<void>}
 */
export async function runWsLifecycleHook(name) {
	const hook = /** @type {any} */ (wsModule)[name];
	if (typeof hook !== 'function') return;
	if (name === 'init') {
		await hook({ platform, workerData: null });
		return;
	}
	try {
		await hook({ platform });
	} catch (err) {
		console.error(`[ws] the ${name} hook threw; the shutdown continued:`, err);
	}
}

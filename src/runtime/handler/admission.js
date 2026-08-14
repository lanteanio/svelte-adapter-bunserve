// The server's one admission controller, plus the marker that carries a
// connection permit from the handshake to the close callback.
//
// It lives in its own module because BOTH ends of a connection's life need it:
// `handler/upgrade.js` acquires, and `handler/ws.js` releases. Importing one of
// those from the other to reach a singleton would be a cycle, and a second
// instance would be worse than a cycle - two sets of counters gating nothing.

import { ws_options } from './config.js';
import { createUpgradeAdmission } from '../utils/upgrade-admission.js';

/**
 * Marks a socket whose handshake reserved a connection permit, so `close`
 * releases exactly the permits that were taken.
 *
 * A Symbol rather than the string key uws needs: uWebSockets.js does not
 * preserve Symbol keys across `res.upgrade()`, so it has to launder a string
 * through userData and promote it in `open`. Bun hands the same `data` object
 * to the socket untouched, so the collision-safe key works directly - and a
 * Symbol cannot be overwritten by a hook that spreads parsed client JSON into
 * its userData, which is the exact hazard the string form has to defend
 * against.
 */
export const WS_CONNECTION_PERMIT = Symbol('adapter.connectionPermit');

/**
 * Whether a block actually gates anything. A ceiling of zero is the documented
 * spelling for "disabled", so `{}` and `{ maxConcurrent: 0 }` describe the same
 * server as omitting the block entirely - and must therefore cost the same.
 *
 * The cursor lane is not in this list on purpose: it carves a sub-budget out of
 * `maxConcurrent` and does nothing without one, so a lane configured alone is
 * still an ungated server.
 *
 * @param {Record<string, any> | undefined} block
 */
function gatesAnything(block) {
	if (!block) return false;
	return (block.maxConcurrent > 0) || (block.maxConnections > 0) || (block.perTickBudget > 0);
}

/**
 * Null when nothing is gated, which is the default and also what a block of
 * zeroes means. Every call site checks for null rather than paying for a
 * controller whose every layer is disabled - and the cost is not the allocation
 * but the await, which reorders the deterministic simulation.
 *
 * @type {ReturnType<typeof createUpgradeAdmission> | null}
 */
export const upgradeAdmission = ws_options && gatesAnything(ws_options.upgradeAdmission)
	? createUpgradeAdmission(ws_options.upgradeAdmission)
	: null;

/**
 * Wait for this upgrade's turn under the per-tick budget.
 *
 * THE ONE PLACE THE TRANSPORT FORCED A DIFFERENT SHAPE, and it is a difference
 * in mechanism rather than in behaviour. uWS holds a `res` it can upgrade from
 * any later tick, so it defers a callback and returns. Bun requires
 * `server.upgrade()` to be called while the fetch handler is still running, so
 * a deferred callback would arrive after the handler had returned and the
 * socket was gone. Awaiting the slot keeps the handler pending instead, which
 * paces upgrades exactly as the budget describes while leaving the request
 * upgradeable.
 *
 * @returns {Promise<boolean>} `false` when the finite queue is full and the
 *   handshake must be refused rather than retained.
 */
export function awaitAdmissionSlot() {
	if (upgradeAdmission === null) return Promise.resolve(true);
	return new Promise((resolve) => {
		// `admit` runs the callback synchronously when this tick has budget, so
		// the common path resolves without ever yielding.
		const outcome = upgradeAdmission.admit(() => resolve(true));
		if (outcome === null) resolve(false);
	});
}

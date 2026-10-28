// Validate response headers when the app constructs an upgrade response.
// The runtime also snapshots and validates them immediately before use because
// the app can mutate the returned object after construction. Both paths use
// the same predicate.
import { assertSafeUpgradeHeaders } from './runtime/utils/upgrade-headers.js';

/**
 * Wrap upgrade hook return value to include response headers on the 101
 * Switching Protocols response (e.g. Set-Cookie for session refresh).
 *
 * Throws a TypeError for an invalid header name, a server-owned handshake
 * header, or a value outside TAB, printable ASCII and Latin-1. Each value must
 * be a string or an array of strings. Validation inside the upgrade hook lets
 * the adapter refuse invalid headers before it attempts the handshake.
 *
 * @template T
 * @param {T} userData - Data attached to ws.getUserData()
 * @param {Record<string, string | string[]>} [headers] - Headers for the 101 response
 * @returns {{ __upgradeResponse: true, userData: T, headers: Record<string, string | string[]> | undefined }}
 */
export function upgradeResponse(userData, headers) {
	// Headers are optional. An app that attaches them conditionally
	// (`upgradeResponse(ud, needsRefresh ? h : undefined)`) must not have its
	// upgrade fail for the no-header case, and the runtime already skips the
	// write when there are none.
	assertSafeUpgradeHeaders(headers);
	return { __upgradeResponse: true, userData, headers };
}

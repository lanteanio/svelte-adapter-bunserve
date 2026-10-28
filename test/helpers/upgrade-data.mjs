// What a real upgrade hands `open` (handler/upgrade.js): the request id rides on
// a slot only the runtime can name, and `open` reports a socket that arrives
// without one as a broken invariant (`ws.request-id-carry`). A stand-in socket
// built on a bare `{}` is one no upgrade could have produced.
//
// Import it with `await import()` after the runtime globals are set, like the
// runtime modules it reads from.
const { CARRY_REQUEST_ID } = await import('../../src/runtime/handler/ws-state.js');

/**
 * @param {Record<PropertyKey, unknown>} [extra] - application userData, as an
 *   upgrade hook would have returned it
 */
export function upgradeData(extra) {
	return { [CARRY_REQUEST_ID]: 'req-test', ...extra };
}

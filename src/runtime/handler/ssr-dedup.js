/**
 * Whether an SSR response may be buffered whole for cross-waiter dedup.
 *
 * The one response that must never be buffered is a Server-Sent-Events stream
 * (`text/event-stream`): it never ends, so `arrayBuffer()` on it would await
 * forever - parking the leader and every concurrent anonymous waiter on the
 * same in-flight promise until the connection drops. Those must stream.
 *
 * Other bodies may be shared if they finish without a pending I/O read and
 * remain within the byte cap. A deferred body falls back to streaming even
 * without a content-length; ready dynamic pages still share their render.
 *
 * Kept in its own dependency-free module so it is unit-testable without pulling
 * in the build-time runtime init chain that `ssr.js` depends on.
 *
 * @param {Response} response
 * @returns {boolean}
 */
export function isDedupBufferable(response) {
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	return !contentType.startsWith('text/event-stream');
}


/** A known oversized response does not enter the bounded sharing collector. */
export function declaresBodyPastCap(response, cap) {
 const declared = response.headers.get('content-length');
 if (declared === null) return false;
 const length = Number(declared);
 return Number.isFinite(length) && length > cap;
}

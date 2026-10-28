// The boot-warmup request tag, kept in its own leaf module.
//
// A warmup render is tagged by object IDENTITY so it cannot be forged from the
// wire. A header would be the obvious spelling and the wrong one: any client
// could send it, and an app that skips audit logging or rate counting for a
// warmup render would then skip it for whoever asked. platform.js reads the tag
// through isWarmupRequest to expose it to app hooks; warmup.js writes it.
//
// A dependency-free leaf both import, deliberately: platform.js would otherwise
// pull the whole warmup module - render engine, timers and all - into its
// import graph for a two-line WeakSet. This module never touches a byte and
// effectively never changes.

/** @type {WeakSet<Request>} */
const warmupRequests = new WeakSet();

/**
 * Tag a request as a synthetic boot-warmup render.
 *
 * @param {Request} request
 */
export function tagWarmupRequest(request) {
	warmupRequests.add(request);
}

/**
 * Whether `request` is a synthetic boot-warmup render rather than a real
 * client request. Tagged by object identity, so a real client cannot forge one.
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isWarmupRequest(request) {
	return warmupRequests.has(request);
}

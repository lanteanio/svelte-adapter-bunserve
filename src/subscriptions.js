// Accounted topic membership for code that joins or leaves a connection's
// topics outside the wire protocol - a presence join, a cursor snapshot, a
// group lane, a plugin in another package.
//
// Calling `ws.subscribe` directly, or writing the connection's subscription
// registry by hand, leaves the worker's subscription accounting behind: the
// registry grows while the counter that `ws_subscriptions` and the pressure
// reading are built on does not, and the release at close then drives that
// counter below zero (`subs.total-negative`). These are the runtime's own
// helpers: native membership, the registry, the per-connection cap, the
// shared-codec cohort and the accounting move together. Every slot they touch
// is a registered symbol or a global hook, so a copy of this module loaded by
// another package - or svelte-adapter-uws's copy of it - reaches the same
// connection state as the runtime that owns it.

export { trackedSubscribe, trackedUnsubscribe, releaseSubscription } from './runtime/utils/ws-symbols.js';

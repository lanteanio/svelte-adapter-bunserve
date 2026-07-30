/**
 * Bounded cache of envelope prefixes. Repeated publishes to the same
 * topic+event pair (the common case - `platform.topic('chat').created(...)` in
 * a loop) reuse one prefix string instead of rebuilding it from four
 * concatenations and two validation scans every time.
 *
 * The building is pure (utils/envelope.js); only the cache lives here.
 */

import { buildEnvelopePrefix } from '../utils/envelope.js';
import { envelopePrefixCache } from './ws-state.js';

export const ENVELOPE_CACHE_MAX = 256;

/**
 * @param {string} topic
 * @param {string} event
 * @returns {string} e.g. '{"topic":"chat","event":"created","data":'
 */
export function envelopePrefix(topic, event) {
	// NUL separates the two names so ('a\0b', 'c') and ('a', 'b\0c') cannot
	// collide on one key - NUL is rejected by esc(), so neither name can
	// contain it.
	const key = topic + '\0' + event;
	let prefix = envelopePrefixCache.get(key);
	if (prefix === undefined) {
		// Built BEFORE the eviction check so a throw from esc() (an illegal
		// topic or event name) leaves the cache untouched.
		prefix = buildEnvelopePrefix(topic, event);
		if (envelopePrefixCache.size >= ENVELOPE_CACHE_MAX) {
			const oldest = envelopePrefixCache.keys().next().value;
			if (oldest !== undefined) envelopePrefixCache.delete(oldest);
		}
		envelopePrefixCache.set(key, prefix);
	}
	return prefix;
}

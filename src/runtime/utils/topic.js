/**
 * Topic and event name rules, shared by the envelope writer and the wire
 * accept path. Pure and dependency-free.
 *
 * The two functions here are deliberately kept in lockstep: `esc` defines what
 * can be embedded in a JSON envelope, and `isValidWireTopic` rejects exactly
 * the same character set at the wire boundary. Any topic that survives the
 * accept check is therefore safe to embed later, so the envelope writer can
 * never be handed something that would corrupt the frame.
 */

/**
 * Quote a string for JSON embedding in a topic / event position.
 *
 * Topics and events are developer-defined identifiers, so a quote, backslash,
 * or control character is always a bug at the call site. This throws rather
 * than silently escaping so the bug surfaces at the publish site instead of
 * emitting malformed JSON onto every subscriber's socket.
 *
 * @param {string} s
 * @returns {string} JSON-quoted string, e.g. '"chat"'
 */
export function esc(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

/**
 * Validate a topic name arriving from a client subscribe / unsubscribe control
 * frame. Non-empty, at most 256 characters, no control bytes, no `"` or `\`.
 *
 * Without `allowNonAscii`, anything above printable ASCII is rejected too. That
 * closes the Unicode line separators (U+2028 / U+2029), the right-to-left
 * override (U+202E), and the byte-order mark (U+FEFF) - all of which survive
 * the wire intact and then surprise whatever renders a topic name back to a
 * human, from a log line to an admin table.
 *
 * Single linear scan, no regex - this is on the accept path of every subscribe.
 *
 * @param {unknown} topic
 * @param {boolean} [allowNonAscii]
 * @returns {boolean}
 */
export function isValidWireTopic(topic, allowNonAscii) {
	if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) return false;
	for (let i = 0; i < topic.length; i++) {
		const c = topic.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) return false;
		if (!allowNonAscii && c > 126) return false;
	}
	return true;
}

/**
 * Is this the adapter's own `__`-prefixed namespace?
 *
 * Presence, cursors and the other internal channels live there, and a client
 * subscribing directly would read traffic the server never meant to expose to
 * it. ONE definition, because this guard has to hold on every lane a client can
 * drive: it was written out by hand on the subscribe path and again on the
 * unsubscribe path, and a guard duplicated per lane is a guard that gets fixed
 * on one of them.
 *
 * Character codes rather than `startsWith`, since this sits on the accept path
 * of every subscribe and unsubscribe. A one-character topic reads `NaN` for the
 * second code point and correctly answers false.
 *
 * @param {string} topic
 * @returns {boolean}
 */
export function isSystemTopic(topic) {
	return topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95;
}

/**
 * Build the `platform.topic(name)` scoped publisher: one small object whose
 * named actions forward to `publish` with the topic bound.
 *
 * @param {(topic: string, event: string, data: unknown) => unknown} publish
 * @param {string} name
 */
export function createScopedTopic(publish, name) {
	return {
		publish: (event, data) => publish(name, event, data),
		created: (data) => publish(name, 'created', data),
		updated: (data) => publish(name, 'updated', data),
		deleted: (data) => publish(name, 'deleted', data),
		set: (value) => publish(name, 'set', value),
		increment: (amount = 1) => publish(name, 'increment', amount),
		decrement: (amount = 1) => publish(name, 'decrement', amount)
	};
}

/**
 * Build a per-publish-binding LRU cache of scoped topic helpers, so repeated
 * `platform.topic(name)` calls reuse one helper instead of allocating a fresh
 * seven-closure object every call. True LRU: a hit moves the key to
 * most-recent, and the oldest key is evicted once the map exceeds `cap`.
 *
 * MUST be created once per publish binding (the platform singleton, a test
 * server) and never module-global keyed on name alone - two servers would
 * otherwise hand out helpers bound to the wrong `publish`.
 *
 * @param {(topic: string, event: string, data: unknown) => unknown} publish
 * @param {number} [cap]
 * @returns {(name: string) => ReturnType<typeof createScopedTopic>}
 */
export function createTopicHelperCache(publish, cap = 256) {
	/** @type {Map<string, ReturnType<typeof createScopedTopic>>} */
	const cache = new Map();
	return function get(name) {
		const hit = cache.get(name);
		if (hit !== undefined) {
			cache.delete(name);
			cache.set(name, hit);
			return hit;
		}
		const helper = createScopedTopic(publish, name);
		cache.set(name, helper);
		if (cache.size > cap) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return helper;
	};
}

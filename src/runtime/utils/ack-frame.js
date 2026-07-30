/**
 * The subscribe / unsubscribe acknowledgement frames.
 *
 * Pure and in one file because every frame here has one invariant that fails
 * SILENTLY when it is broken: a denial frame that does not carry the topic the
 * client named is DISCARDED by the family client, whose branch is guarded by
 * `typeof msg.topic === 'string'`. Neither side reports anything - the server
 * logs a refusal, the client sees nothing, and the subscription never appears.
 *
 * Building every ack through this module is what makes "does every frame the
 * demux can emit name its topic?" a question a test can ask of every builder.
 *
 * `type` is written FIRST in every literal: JSON.stringify emits string keys in
 * insertion order, and the recognisers in control-frame.js anchor on `type`
 * being the first key. See the protocol note at the top of handler/ws.js.
 *
 * The topic is echoed as the client sent it, including when it is not a string.
 * A client correlating a denial against what it sent needs the value it sent,
 * not a normalised one - `String(topic)` turns the `{}` that was refused into
 * "[object Object]", which matches nothing the client is holding.
 */

/**
 * Largest `ref` that may be echoed back, in BYTES.
 *
 * Bytes, not `String.length`. The two disagree by up to 3x for non-ASCII, and
 * the budget this protects charges in bytes: 128 U+FFFD characters are
 * `length === 128` and 384 bytes, so a length-based cap admitted three times
 * the ref it was written to allow into every echoed frame - multiplied by the
 * batch size, since a batch is answered per entry.
 */
const MAX_REF_BYTES = 128;

/**
 * May this `ref` be echoed back to the client?
 *
 * A ref the adapter refuses is treated as absent, which costs that client its
 * acks and nothing else.
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isEchoableRef(ref) {
	if (typeof ref === 'number') return true;
	if (typeof ref !== 'string') return false;
	// The cheap test first: UTF-8 never exceeds 3 bytes per UTF-16 code unit,
	// so a short enough string is under the cap without measuring it.
	if (ref.length * 3 <= MAX_REF_BYTES) return true;
	return Buffer.byteLength(ref) <= MAX_REF_BYTES;
}

/**
 * @param {unknown} topic
 * @param {number | string} ref
 * @param {number} epoch
 * @returns {string}
 */
export function subscribedFrame(topic, ref, epoch) {
	return JSON.stringify({ type: 'subscribed', topic, ref, epoch });
}

/**
 * @param {unknown} topic
 * @param {number | string} ref
 * @param {string} reason
 * @returns {string}
 */
export function subscribeDeniedFrame(topic, ref, reason) {
	return JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
}

/**
 * @param {unknown} topic
 * @param {number | string} ref
 * @returns {string}
 */
export function unsubscribedFrame(topic, ref) {
	return JSON.stringify({ type: 'unsubscribed', topic, ref });
}

/**
 * Its own frame type rather than a reused `unsubscribed` ack: the ack means
 * "you no longer hold this", which is a claim the adapter cannot make about a
 * topic it refused to look at.
 *
 * @param {unknown} topic
 * @param {number | string} ref
 * @param {string} reason
 * @returns {string}
 */
export function unsubscribeDeniedFrame(topic, ref, reason) {
	return JSON.stringify({ type: 'unsubscribe-denied', topic, ref, reason });
}

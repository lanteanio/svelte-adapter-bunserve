/**
 * The JSON envelope the client store understands:
 * `{"topic":"chat","event":"created","data":<json>[,"seq":N][,"j":ms]}`.
 *
 * Built by string concatenation rather than JSON.stringify on an object: the
 * topic and event are already validated identifiers (see utils/topic.js), so
 * the only part needing a real serializer is `data`. Splitting the build into a
 * reusable prefix plus a completion is what lets the caller cache the prefix
 * per topic+event pair and pay only the data serialization per publish.
 *
 * Pure and dependency-free. The prefix cache that sits on top of this lives in
 * handler/envelope-cache.js, because a cache is state and this is not.
 */

import { esc } from './topic.js';

/**
 * Build the constant leading portion of an envelope for a topic+event pair.
 *
 * @param {string} topic
 * @param {string} event
 * @returns {string} e.g. '{"topic":"chat","event":"created","data":'
 */
export function buildEnvelopePrefix(topic, event) {
	return '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":';
}

/**
 * Complete an envelope from a prefix and its payload.
 *
 * `undefined` data serializes as `null` so the frame stays valid JSON:
 * JSON.stringify(undefined) returns undefined, which would concatenate the
 * string "undefined" into the frame and break every client parse.
 *
 * @param {string} prefix - output of buildEnvelopePrefix
 * @param {unknown} data
 * @param {number | null} [seq] - sequence number, omitted when null/undefined
 * @param {number | null} [jitterMs] - de-herd window carried to the client
 * @returns {string}
 */
export function completeEnvelope(prefix, data, seq, jitterMs) {
	const body = prefix + JSON.stringify(data ?? null);
	const tail = jitterMs == null ? '}' : ',"j":' + jitterMs + '}';
	return seq == null ? body + tail : body + ',"seq":' + seq + tail;
}

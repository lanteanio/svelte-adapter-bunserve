/**
 * The wire-codec registry: capability token -> the codec descriptor a plugin
 * registered with `platform.registerWireCodec`.
 *
 * Registration is idempotent and last-wins per capability, so a plugin that
 * re-registers on hot reload does not accumulate entries. The registry is read
 * where a codec must be resolved from a capability token alone rather than
 * passed in by the caller - today that is diagnostic surface only; the
 * cluster-relay receive path is its consumer once multi-node lands.
 */

/** @type {Map<string, any>} */
const codecs = new Map();

/**
 * @param {{ capability?: unknown }} wire - a codec descriptor; entries without
 *   a string capability are ignored rather than thrown on, matching the
 *   platform's tolerance for partially-understood registrations.
 */
export function registerWireCodec(wire) {
	if (!wire || typeof wire.capability !== 'string') return;
	codecs.set(wire.capability, wire);
}

/**
 * @param {string} capability
 * @returns {any | null}
 */
export function getWireCodec(capability) {
	return codecs.get(capability) ?? null;
}

/** Test seam: forget every registered codec. @internal */
export function _resetWireCodecRegistry() {
	codecs.clear();
}

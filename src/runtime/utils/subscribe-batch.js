/**
 * The `subscribeBatch` verdict mapping.
 *
 * The hook gates a whole batch in one call and returns a DENIALS object keyed by
 * topic. The verdict is read from the VALUE, matching the family: `false` or a
 * reason string denies; an absent key, `true`, or `undefined` all allow. It is
 * emphatically NOT presence-keyed, and documenting it as such is what gets a
 * hook author to write `denials[t] = maybeUndefined` and expect a denial.
 *
 * Turning that into a per-topic verdict is the part worth isolating, because
 * "allow" has a trap: it must become an explicit `null`, never `undefined`.
 * `undefined` reads downstream as "nothing decided", which falls back to the
 * per-topic `subscribe` gate that an app exporting `subscribeBatch` deliberately
 * did not write. Every topic asked about therefore comes back with an answer.
 *
 * Pure, so the mapping can be tested without a socket or a hook.
 */

let warnedUnreadable = false;
/**
 * One-shot: it describes a static code shape in the app's hook, not a per-frame
 * condition, so repeating it per batch would be the flood the throttles exist
 * to prevent.
 *
 * @param {unknown} denials
 */
function warnUnreadableDenials(denials) {
	if (warnedUnreadable) return;
	warnedUnreadable = true;
	const kind = Array.isArray(denials)
		? 'an array'
		: `a ${Object.getPrototypeOf(denials)?.constructor?.name ?? 'non-plain object'}`;
	console.error(
		`[ws] subscribeBatch returned ${kind}, which cannot be read as a denials map, so every\n` +
		'  subscription in the batch is being DENIED with INTERNAL_ERROR. Return a PLAIN OBJECT\n' +
		'  keyed by topic:\n' +
		"    return { 'room:1': 'FORBIDDEN' };   // absent key allows\n" +
		'  A real `Map` is the usual mistake - the word "map" in the docs means a plain object.'
	);
}

/**
 * The shapes a verdict may take. Anything else is a value the adapter cannot
 * read as allow OR deny, so it fails closed rather than becoming an ALLOW for a
 * topic the hook was trying to deny.
 *
 * Shared with the per-topic lane in handler/platform.js. Both gates answer the
 * same question about the same kind of value, and when they answered it
 * differently the identical hook logic denied through `subscribeBatch` and
 * allowed through `subscribe`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isReadableVerdict(value) {
	return (
		value === false ||
		value === true ||
		value === null ||
		value === undefined ||
		typeof value === 'string'
	);
}

let warnedUnreadableVerdict = false;
/**
 * One-shot for the same reason as the container warning: it describes a static
 * shape in the app's hook, not a per-frame condition.
 *
 * The topic is named because a hook usually gets this wrong for one branch, and
 * the value's TYPE is named because that is the whole diagnosis. The value
 * itself is not printed - it is app data on a client-named topic.
 *
 * @param {string} topic
 * @param {unknown} value
 * @param {string} [hookName] - the gate that returned it
 */
export function warnUnreadableVerdict(topic, value, hookName = 'subscribeBatch') {
	if (warnedUnreadableVerdict) return;
	warnedUnreadableVerdict = true;
	const kind =
		value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
	const example =
		hookName === 'subscribeBatch'
			? "    return { 'room:1': 'FORBIDDEN' };\n"
			: "    return 'FORBIDDEN';\n";
	console.error(
		`[ws] ${hookName} returned ${kind} for the topic ${JSON.stringify(topic)}, which is not a\n` +
		'  readable verdict, so that subscription is being DENIED with INTERNAL_ERROR. A denial is\n' +
		'  `false` or a reason STRING; `true`, `null` and `undefined` allow:\n' +
		example +
		'  A Promise is the usual mistake - an `async` lookup returned without `await`.'
	);
}

/**
 * @param {string[]} topics - the topics the gate was asked about
 * @param {unknown} denials - whatever the hook returned
 * @returns {Map<string, unknown>} one entry per topic, `null` meaning allow
 */
export function mapBatchDenials(topics, denials) {
	/** @type {Map<string, unknown>} */
	const verdicts = new Map();
	// `undefined` or `{}` means "allow everything", which falls out of the
	// absent-key rule below.
	//
	// A PLAIN object only. `typeof x === 'object'` is also true for a Map, a
	// Set and an array - and for all three `hasOwnProperty` finds no topic, so
	// every denial silently became an allow. The README says "return a map of
	// topic -> denial reason", so a hook author reaching for an actual `Map` is
	// a realistic mistake, and it is the one shape in this file that failed
	// WIDE OPEN with no signal. Anything else is treated as no decision at all
	// and fails closed.
	const proto = denials === null || typeof denials !== 'object'
		? undefined
		: Object.getPrototypeOf(denials);
	const plain = proto === Object.prototype || proto === null;
	if (denials !== undefined && denials !== null && !plain) {
		// LOUD. Failing closed is right, but silently denying every subscription
		// in the app while the hook looks correct is not debuggable: a throwing
		// hook logs, and this must too.
		warnUnreadableDenials(denials);
		return denyAllBatch(topics, 'INTERNAL_ERROR');
	}
	for (const topic of topics) {
		// `__proto__` cannot be an own key of an object literal - the assignment
		// hits Object.prototype's accessor and creates nothing - so a hook that
		// writes `denials['__proto__'] = 'FORBIDDEN'` produces an object where
		// the denial is simply absent, and the topic would read as ALLOWED.
		// There is no way to tell that apart from a hook that meant to allow it,
		// so it fails closed. Only reachable at all with
		// `allowSystemTopicSubscribe: true`, since the `__` guard refuses it
		// otherwise.
		if (topic === '__proto__') {
			verdicts.set(topic, 'INTERNAL_ERROR');
			continue;
		}
		const present = plain && Object.prototype.hasOwnProperty.call(denials, topic);
		// A present key whose VALUE is undefined still denies nothing useful,
		// but it must not read as "no verdict" either: `undefined` downstream
		// means "nothing decided", which falls back to a gate the app did not
		// write. `denials[t] = REASONS[t]` on a lookup miss produces exactly
		// this, so it is the natural way to write the hook wrong.
		const value = present ? /** @type {any} */ (denials)[topic] : null;
		// The VALUE is validated as strictly as the container. Downstream, a
		// verdict that is not `false` and not a string reads as ALLOW, so a value
		// of the wrong TYPE silently allows a topic the hook was denying - the
		// same fail-wide-open the Map/array container check above closes, one
		// level down. The realistic shape is a forgotten `await`
		// (`denials[t] = db.denialFor(t)` stores a Promise), and `403` or
		// `new Error('FORBIDDEN')` are the same mistake. Only the four documented
		// shapes are readable: `false` and a string deny, `true` and `undefined`
		// allow; `null` is the absent-key spelling and allows.
		if (!isReadableVerdict(value)) {
			warnUnreadableVerdict(topic, value);
			verdicts.set(topic, 'INTERNAL_ERROR');
			continue;
		}
		verdicts.set(topic, value === undefined ? null : value);
	}
	return verdicts;
}

/**
 * Every topic fails closed. Used when the gate threw: it reached no decision,
 * which is not the same as having no opinion.
 *
 * @param {string[]} topics
 * @param {string} reason
 * @returns {Map<string, unknown>}
 */
export function denyAllBatch(topics, reason) {
	/** @type {Map<string, unknown>} */
	const verdicts = new Map();
	for (const topic of topics) verdicts.set(topic, reason);
	return verdicts;
}

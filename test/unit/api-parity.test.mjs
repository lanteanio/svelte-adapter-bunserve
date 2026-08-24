import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// svelte-adapter-uws LEADS this adapter, and the two are meant to be drop-in
// replacements for each other. That claim is worth exactly as much as the
// mechanism that checks it, so this file checks it mechanically against
// probe/uws-surface.json - a committed extract of uws's own index.d.ts,
// regenerated with `npm run probe:uws`.
//
// HOW TO READ A FAILURE HERE. Every difference between the two adapters has to
// be listed below, and the lists are exact: an entry that no longer describes
// reality fails just as loudly as an unlisted difference. So a failure means
// one of four things, and the message says which:
//
//   - uws added public API      -> implement it, or record it as a gap
//   - uws removed public API    -> drop ours, or record it as an extension
//   - we added API uws lacks    -> that is DRIFT; get it into uws or drop it
//   - we closed a gap           -> delete the entry, the list is stale
//
// Listing something here is an ACKNOWLEDGEMENT, never an endorsement. The
// entries are grouped by the feature area they belong to so the shape of the
// remaining work reads at a glance.

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

register('../helpers/ws-handler-loader.mjs', import.meta.url);

const { platform } = await import('../../src/runtime/handler/platform.js');
const { KNOWN_ADAPTER_OPTIONS } = await import('../../src/adapter-options.js');
const { INERT_WS_OPTION_KEYS, KNOWN_WS_OPTION_KEYS, normalizeWsOptions } =
	await import('../../src/runtime/utils/ws-options.js');

const surface = JSON.parse(
	readFileSync(new URL('../../probe/uws-surface.json', import.meta.url), 'utf8')
);

/**
 * Members apps reach through `platform` that are attached per request or per
 * connection rather than living on the shared singleton, so introspecting the
 * singleton cannot see them. Kept explicit: silently treating an absent member
 * as "probably dynamic" is how a real gap would hide.
 */
const DYNAMIC_PLATFORM_MEMBERS = ['requestId'];

/** uws platform members this adapter does not implement. */
const PLATFORM_GAPS = {
	diagnostic: 'request tracing',
	trace: 'request tracing',
	traceContext: 'request tracing',
	authorizeWireSubscribe: 'wire-subscribe authorization',
	grantPublish: 'client-publish grants',
	publishGrant: 'client-publish grants',
	revokePublish: 'client-publish grants',
	request: 'RPC over the socket',
	requestTopic: 'RPC over the socket',
	batch: 'batched publish API',
	publishBatched: 'batched publish API',
	sendCoalesced: 'per-key send coalescing',
	publishGame: 'game ingress lane',
	hlc: 'hybrid logical clock (cluster ordering)',
	topicEpoch: 'resume epoch introspection',
	introspect: 'diagnostics'
};

/**
 * Members this adapter exposes that uws does not declare. Every one of these is
 * DRIFT against the lead, not a feature: an app written against them cannot
 * move back to uws, which is half of "drop-in replacement".
 */
const PLATFORM_EXTRAS = {
	publishCount: 'drift: uws keeps an internal publishCountWindow and exposes no counter',
	totalSubscriptions: 'drift: uws reports this through its metrics registry, not on platform',
	droppedReleaseRecords: 'drift: no uws equivalent'
};

/**
 * Top-level adapter options uws declares and this adapter does not accept.
 *
 * Both entries arrived with the tracing surface and the static-cache header
 * work. Neither is implemented here, so both are acknowledged rather than
 * counted as parity.
 */
const ADAPTER_OPTION_GAPS = {
	staticCacheControl: 'static cache-control headers',
	tracing: 'request tracing'
};

/** Top-level adapter options this adapter accepts that uws does not declare. */
const ADAPTER_OPTION_EXTRAS = {
	staticCacheMaxFileSize: 'drift: no equivalent in the pinned uws release'
};

/** `websocket.*` keys uws declares and this adapter does not accept. */
const WS_OPTION_GAPS = {
	// Accepted so a carried config builds, and not loaded - the feature is the
	// operator-owned registry, which this adapter does not have. See
	// INERT_WS_OPTION_KEYS.
	metrics: 'operator-owned metrics registry',
	adminPath: 'admin endpoint',
	maxTopicSeqEntries: 'bounded topic-seq registry',
	messageAdmission: 'inbound message admission',
	// The outbound half of what `messageAdmission` bounds on the way in:
	// per-window publish ceilings held per scope in a bounded ledger. Arrived
	// with the 0.6.0-next.92 cut.
	egress: 'publish-egress ceilings',
	adminAuthAcknowledged: 'admin endpoint',
	authorizeWireSubscribe: 'wire-subscribe authorization',
	consistencyAuditIntervalMs: 'background audits',
	resourceGrowthAuditIntervalMs: 'background audits',
	stateHashIntervalMs: 'background audits',
	postureExport: 'pressure/protection observability',
	protection: 'pressure/protection observability',
	primaryInit: 'multi-worker clustering',
	workers: 'multi-worker clustering',
	unsafeSameOriginWithoutHostPin: 'origin pinning escape hatch'
};

/**
 * Export subpaths uws declares and this adapter does not. A single-entry
 * adapter today: the browser client and the plugin families ship from uws's
 * own package, and the sim stays internal, reached by path from scripts/ and
 * test/ rather than exported.
 */
const EXPORT_GAPS = {
	'./client': 'browser client',
	'./connection': 'connection introspection',
	'./observability': 'request tracing',
	'./plugins/channels': 'plugin: channels',
	'./plugins/channels/client': 'plugin: channels',
	'./plugins/crdt': 'plugin: crdt',
	'./plugins/crdt/channel': 'plugin: crdt',
	'./plugins/crdt/client': 'plugin: crdt',
	'./plugins/crdt/replica': 'plugin: crdt',
	'./plugins/cursor': 'plugin: cursor',
	'./plugins/cursor/client': 'plugin: cursor',
	'./plugins/dedup': 'plugin: dedup',
	'./plugins/groups': 'plugin: groups',
	'./plugins/groups/client': 'plugin: groups',
	'./plugins/lock': 'plugin: lock',
	'./plugins/middleware': 'plugin: middleware',
	'./plugins/presence': 'plugin: presence',
	'./plugins/presence/client': 'plugin: presence',
	'./plugins/queue': 'plugin: queue',
	'./plugins/ratelimit': 'plugin: ratelimit',
	'./plugins/replay': 'plugin: replay',
	'./plugins/replay/client': 'plugin: replay',
	'./plugins/session': 'plugin: session',
	'./plugins/smooth': 'plugin: smooth',
	'./plugins/smooth/client': 'plugin: smooth',
	'./plugins/smooth/random': 'plugin: smooth',
	'./plugins/throttle': 'plugin: throttle',
	'./plugins/webhooks': 'plugin: webhooks',
	'./safe-url': 'safe-url helper',
	'./sim': 'sim is internal here, reached by path, not exported',
	'./testing': 'testing server double',
	'./upgrade-response': 'upgrade-response helper',
	'./vite': 'vite dev plugin'
};

/** Export subpaths this adapter declares that uws does not. */
const EXPORT_EXTRAS = {};

/** `websocket.*` keys this adapter accepts that uws does not declare. */
const WS_OPTION_EXTRAS = {
	allowUnauthenticatedSubscribe: 'drift: uws gates this differently',
	publishToSelf: 'drift: no uws equivalent',
	maxSubscriptionsPerConnection: 'drift: no uws equivalent',
	maxControlEgressBytes: 'drift: no uws equivalent',
	maxConcurrentSubscribeGates: 'drift: no uws equivalent',
	maxConcurrentUnsubscribeHooks: 'drift: no uws equivalent',
	maxQueuedUnsubscribeHooks: 'drift: no uws equivalent'
};

/**
 * One dimension of the comparison, asserted in both directions plus staleness.
 *
 * @param {string} label
 * @param {string[]} ours
 * @param {string[]} theirs
 * @param {Record<string, string>} gaps - theirs, not ours
 * @param {Record<string, string>} extras - ours, not theirs
 */
function assertParity(label, ours, theirs, gaps, extras) {
	const ourSet = new Set(ours);
	const theirSet = new Set(theirs);

	const undeclaredExtras = ours.filter((k) => !theirSet.has(k) && !(k in extras));
	assert.deepEqual(
		undeclaredExtras,
		[],
		`${label}: exposed here but not declared by uws, and not recorded as drift. ` +
		'Get it into uws or drop it - an app using it cannot move back.'
	);

	const unrecordedGaps = theirs.filter((k) => !ourSet.has(k) && !(k in gaps));
	assert.deepEqual(
		unrecordedGaps,
		[],
		`${label}: uws declares these and this adapter does not. Implement them, or ` +
		'record them as gaps with the feature area they belong to.'
	);

	const staleGaps = Object.keys(gaps).filter((k) => ourSet.has(k) || !theirSet.has(k));
	assert.deepEqual(
		staleGaps,
		[],
		`${label}: recorded as gaps but no longer missing (implemented here, or gone from ` +
		'uws). Delete the entries - a stale list is a list nobody trusts.'
	);

	const staleExtras = Object.keys(extras).filter((k) => !ourSet.has(k) || theirSet.has(k));
	assert.deepEqual(
		staleExtras,
		[],
		`${label}: recorded as drift but no longer drift (dropped here, or uws adopted it). ` +
		'Delete the entries.'
	);
}

test('the uws surface manifest is present and plausible', () => {
	// A missing or degenerate manifest must FAIL, never skip. Every other
	// assertion in this file is measured against it, so an empty one would turn
	// the whole suite green while proving nothing - the exact shape of dead
	// assertion this repo keeps re-learning.
	assert.ok(surface.uwsVersion, 'the manifest records which uws version it came from');
	assert.ok(surface.platform.length >= 30, `platform members: ${surface.platform.length}`);
	assert.ok(surface.adapterOptions.length >= 5, `adapter options: ${surface.adapterOptions.length}`);
	assert.ok(surface.webSocketOptions.length >= 5, `ws options: ${surface.webSocketOptions.length}`);
	assert.ok(surface.exports.length >= 5, `export subpaths: ${surface.exports.length}`);
});

test('platform surface matches the uws contract, or the difference is recorded', () => {
	const ours = [...Object.getOwnPropertyNames(platform), ...DYNAMIC_PLATFORM_MEMBERS];
	assertParity('platform', ours, surface.platform, PLATFORM_GAPS, PLATFORM_EXTRAS);
});

test('adapter options match the uws contract, or the difference is recorded', () => {
	assertParity(
		'adapter option',
		KNOWN_ADAPTER_OPTIONS,
		surface.adapterOptions,
		ADAPTER_OPTION_GAPS,
		ADAPTER_OPTION_EXTRAS
	);
});

test('websocket options match the uws contract, or the difference is recorded', () => {
	// ACCEPTED IS NOT HONOURED. A key the validator stopped calling unknown so a
	// carried config would build is still a feature this adapter does not have,
	// and counting it as parity is how the list would come to say a migrating app
	// keeps behaviour it actually loses. The nested probe next door already
	// models this - it asks the validator whether the key does anything, not
	// whether it is recognised - and this is the flat list's equivalent.
	const ours = [...KNOWN_WS_OPTION_KEYS].filter((k) => !INERT_WS_OPTION_KEYS.has(k));
	assertParity(
		'websocket option',
		ours,
		surface.webSocketOptions,
		WS_OPTION_GAPS,
		WS_OPTION_EXTRAS
	);
});

/**
 * Values every protective number is driven through, chosen for the boundaries
 * rather than for coverage: zero, a fraction below every floor, the floor
 * itself, fractions above it, and sizes on either side of the fixed-width
 * bound uws grew later.
 */
const RANGE_PROBE_VALUES = [0, 0.5, 1, 1.5, 2, 1000, 1048576, 1048576.5, 2147483647, 3000000000];

/**
 * Whether uws accepts a value, decided from the range it records in the
 * manifest rather than from a copy of its guard kept here. Mirrors the shape of
 * `assertProtectiveNumber`: a ceiling brings a SAFE-INTEGER requirement with it,
 * because in uws the two arrive together and for the same reason.
 *
 * @param {{ allowZero: boolean, floor: number, ceiling: number | null, integerRequired: boolean }} contract
 * @param {number} value
 * @returns {boolean}
 */
function uwsAcceptsValue(contract, value) {
	if (!Number.isFinite(value)) return false;
	if (value === 0) return contract.allowZero;
	if (value < contract.floor) return false;
	// Checked apart, because they no longer arrive together: uws couples a ceiling
	// with a safe-integer requirement in its config guard, and the gate asserts the
	// integer rule for the admission bounds with no ceiling at all.
	if (contract.integerRequired && !Number.isSafeInteger(value)) return false;
	if (contract.ceiling !== null && value > contract.ceiling) return false;
	return true;
}

/**
 * Whether THIS adapter accepts a value, decided by running the real validator.
 *
 * @param {string} key
 * @param {number} value
 * @returns {boolean}
 */
function weAcceptValue(key, value) {
	try {
		normalizeWsOptions({ [key]: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * Options this adapter accepts a NARROWER set of values for than uws, with the
 * reason each difference exists.
 *
 * Every entry here is forced by Bun, not chosen: Bun.serve validates these
 * three itself and throws on a value uws would take. Widening any of them to
 * match uws would move a build-time refusal into a server that fails to start,
 * which is worse than the difference. The measured errors are quoted so the
 * next reader can re-run them rather than trust this list.
 *
 * The list is EXACT in both directions - an unrecorded difference fails, and so
 * does an entry that no longer describes one.
 */
const RANGE_DIVERGENCES = {
	maxBackpressure: {
		refuses: [1.5, 1048576.5],
		because: 'Bun.serve throws "websocket expects backpressureLimit to be an integer" ' +
			'(measured on 1.3.14 and 1.4.0, identical message on both)'
	},
	idleTimeout: {
		refuses: [0.5, 1.5, 1000, 1048576, 1048576.5, 2147483647, 3000000000],
		because: 'Bun.serve throws "websocket expects idleTimeout to be an integer" (measured on ' +
			'1.3.14 and 1.4.0, identical message on both), and separately refuses anything above ' +
			'960, which the validator reports as its own error'
	}
};

test('the VALUES each option accepts match uws, or the difference is recorded', () => {
	// THE LISTS ABOVE COMPARE NAMES. Two adapters can agree on every option name
	// and still disagree about what those options accept, and that disagreement
	// is not cosmetic: it is a config that builds on one adapter and fails the
	// build on the other, which is the failure this whole file exists to catch.
	// It got past every other test in this repo once - a rate-limit window whose
	// floor was 0.001 here against 1 there - and was found by a person reading
	// two validators side by side, because nothing mechanical could see it.
	for (const [key, contract] of Object.entries(surface.protectiveNumbers)) {
		const narrower = RANGE_PROBE_VALUES.filter(
			(v) => uwsAcceptsValue(contract, v) && !weAcceptValue(key, v)
		);
		const recorded = RANGE_DIVERGENCES[key];
		assert.deepEqual(
			narrower,
			recorded ? recorded.refuses : [],
			recorded
				? `\`websocket.${key}\` no longer refuses exactly what the divergence records. ` +
					`Recorded: ${JSON.stringify(recorded.refuses)} (${recorded.because}). ` +
					'Update the entry, or delete it if the difference is gone.'
				: `\`websocket.${key}\` refuses ${JSON.stringify(narrower)}, which uws accepts, and ` +
					'nothing records why. A config valid on uws must build here: either widen this ' +
					'adapter to take them, or add an entry to RANGE_DIVERGENCES saying what forces the ' +
					'difference.'
		);
	}
});

test('and this adapter never accepts a bound uws would refuse', () => {
	// The other direction, and the one with no allowlist. Accepting MORE than
	// uws does not break a migration into this adapter - it breaks the way back
	// out, which is the half of "drop-in replacement" that is easy to forget:
	// the config an operator tuned here fails the build there, and the failure
	// arrives long after the decision that caused it.
	//
	// Empty today at the pinned commit. It is the check that turns uws's later
	// bounds into a failing test here rather than a silent divergence: uws has
	// since capped `maxPayloadLength` at 0x7fffffff, so the day this repo's pin
	// moves past that release, this test names the option and the value.
	for (const [key, contract] of Object.entries(surface.protectiveNumbers)) {
		const looser = RANGE_PROBE_VALUES.filter(
			(v) => weAcceptValue(key, v) && !uwsAcceptsValue(contract, v)
		);
		assert.deepEqual(
			looser,
			[],
			`\`websocket.${key}\` accepts ${JSON.stringify(looser)}, which uws refuses. A config ` +
				'tuned here would fail the build on uws, so this adapter has to refuse them too.'
		);
	}
});

test('the nested upgradeAdmission bounds accept what uws accepts, in both directions', () => {
	// THE DIMENSION THE TEST ABOVE CANNOT REACH. uws asserts the top-level
	// protective numbers while it reads the config and these four inside the gate
	// it builds, so they live in a different file and never appeared in the range
	// manifest. That gap was not hypothetical: this adapter required only a finite
	// number for them while uws required a non-negative safe integer, so
	// `maxConcurrent: 1.5` built here and failed there, and nothing said so.
	//
	// No allowlist in either direction. There is no runtime reason for these to
	// differ - unlike the three above, which Bun forces - so a difference here is
	// a defect rather than a fact to record.
	const contracts = surface.nestedProtectiveNumbers.upgradeAdmission;
	for (const [key, contract] of Object.entries(contracts)) {
		const narrower = RANGE_PROBE_VALUES.filter(
			(v) => uwsAcceptsValue(contract, v) && !weAcceptValue('upgradeAdmission', { [key]: v })
		);
		const looser = RANGE_PROBE_VALUES.filter(
			(v) => weAcceptValue('upgradeAdmission', { [key]: v }) && !uwsAcceptsValue(contract, v)
		);
		assert.deepEqual(
			narrower,
			[],
			`\`websocket.upgradeAdmission.${key}\` refuses ${JSON.stringify(narrower)}, which uws ` +
				'accepts, so a config that runs there fails the build here.'
		);
		assert.deepEqual(
			looser,
			[],
			`\`websocket.upgradeAdmission.${key}\` accepts ${JSON.stringify(looser)}, which uws ` +
				'refuses, so a config tuned here fails the build there.'
		);
	}
});

test('an accepted-but-inert key is recorded as a gap, and says so at build time', () => {
	// Both halves, because either alone is a way for the key to look implemented:
	// recorded as a gap but silently swallowed, or warned about but counted as
	// parity.
	for (const key of INERT_WS_OPTION_KEYS) {
		assert.ok(
			key in WS_OPTION_GAPS,
			`\`websocket.${key}\` is accepted and not honoured, so it is a recorded gap`
		);
		assert.ok(
			KNOWN_WS_OPTION_KEYS.has(key),
			`\`websocket.${key}\` is accepted, or it would not need to be listed as inert`
		);
	}
	// The one that exists today, driven through the real validator: a valid value
	// builds, the build says what the adapter does instead, and NOTHING IS KEPT.
	// The third check is the one the other two cannot make - a stored value is a
	// key that becomes honoured the moment some module reads it, with the warning
	// still firing and both lists still calling it a gap.
	const { options, warnings } = normalizeWsOptions({ metrics: './src/lib/metrics.js' });
	assert.ok(
		warnings.some((w) => w.includes('`websocket.metrics`') && w.includes('does not load it')),
		'the build says the module is not loaded'
	);
	assert.equal(options.metrics, undefined, 'and keeps nothing for a later reader to honour');
});

test('export subpaths match the uws contract, or the difference is recorded', () => {
	const pkg = JSON.parse(
		readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
	);
	assertParity('export subpath', Object.keys(pkg.exports), surface.exports, EXPORT_GAPS, EXPORT_EXTRAS);
});

test('the options uws nests under `websocket` are nested here too, not top-level', () => {
	// Kept as its own test after the fact, because this is the one class of
	// difference that silently MISCONFIGURES a migrating app rather than merely
	// missing a feature: a key in the wrong position is accepted as unknown,
	// warned about at build time at best, and the behaviour it was meant to set
	// never applies. The lists above would catch a regression, but not say why
	// it matters.
	for (const key of ['handler', 'path', 'compressCredentialedResponses']) {
		assert.ok(surface.webSocketOptions.includes(key), `uws nests ${key} under websocket`);
		assert.ok(KNOWN_WS_OPTION_KEYS.has(key), `and so does this adapter (websocket.${key})`);
	}
	// The superseded top-level spellings must be GONE, not merely deprecated:
	// accepting both would let a config be valid here and silently inert in uws,
	// which is the failure this move exists to remove.
	for (const key of ['websocketHandler', 'websocketPath', 'compressCredentialedResponses']) {
		assert.ok(
			!KNOWN_ADAPTER_OPTIONS.includes(key),
			`\`${key}\` is no longer a top-level option; uws has never had one`
		);
	}
});

/**
 * Keys INSIDE a nested option block, per block. The flat `websocket.*` list
 * cannot see these: a whole sub-key can be missing while the block's own name
 * matches on both sides, which is how `upgradeAdmission.waitingRoom` stayed
 * invisible until it turned a working uws config into a build failure here.
 *
 * Only blocks this adapter actually implements are listed. A block recorded in
 * WS_OPTION_GAPS is missing entirely, and its sub-keys would be noise.
 */
const NESTED_GAPS = {
	upgradeAdmission: {}
};

/** Sub-keys this adapter accepts that the pinned uws release does not declare. */
const NESTED_EXTRAS = {
	// Empty: uws declares every sub-key this adapter accepts. `maxConnections`
	// and `maxDeferred` were recorded here while they were ahead of the pin, and
	// the pin has now moved past the release that adopted them.
	upgradeAdmission: {}
};

test('nested websocket option blocks match the uws contract, or the difference is recorded', () => {
	const theirs = surface.nestedWebSocketOptions;
	assert.ok(theirs && typeof theirs === 'object', 'the manifest records nested option keys');

	for (const block of Object.keys(NESTED_GAPS)) {
		const declared = theirs[block];
		assert.ok(Array.isArray(declared), `uws declares nested keys for \`${block}\``);
		// Read from the live validator rather than a hand-copied list, so this
		// cannot pass against a set that the adapter does not actually accept.
		const ours = acceptedNestedKeys(block);
		assertParity(
			`websocket.${block}`,
			ours,
			declared,
			NESTED_GAPS[block],
			NESTED_EXTRAS[block] ?? {}
		);
	}
});

/**
 * What `normalizeWsOptions` actually accepts inside a block, discovered by
 * offering each candidate key and seeing whether it warns about being ignored.
 * Probing the real validator is the point: a list maintained by hand here would
 * be a second copy of the thing under test.
 *
 * @param {string} block
 * @returns {string[]}
 */
function acceptedNestedKeys(block) {
	const candidates = new Set([
		...(surface.nestedWebSocketOptions[block] ?? []),
		'maxConnections', 'maxDeferred'
	]);
	const accepted = [];
	for (const key of candidates) {
		// Shape-appropriate probe values: a block that must be an object is
		// REFUSED when handed a number, and that refusal is not the same answer
		// as "this key is ignored".
		const probe = surface.nestedWebSocketOptions[`${block}.${key}`] ? {} : 1;
		const { warnings } = normalizeWsOptions({ [block]: { [key]: probe } });
		const ignored = warnings.some((w) => w.includes(`${block}.${key}\` is ignored`));
		if (!ignored) accepted.push(key);
	}
	return accepted.sort();
}

test('the vendored protocol schema is byte-identical to the uws copy at the pin', async () => {
	// uws is the schema's home; this repo ships a vendored copy so consumers
	// (and the runtime's own version banner, which parses the protocol
	// revision from it) do not need uws installed. A copy is only safe under
	// a gate: the manifest records the sha256 of the schema at the pinned
	// commit, and this hashes the committed copy against it, so the two
	// cannot drift apart silently. Regenerate with `npm run probe:uws`
	// (UWS_REF=<sha>) and re-vendor when uws revs the protocol.
	const { createHash } = await import('node:crypto');
	const vendored = readFileSync(new URL('../../protocol.schema.json', import.meta.url));
	const hash = createHash('sha256').update(vendored).digest('hex');
	assert.equal(
		hash,
		surface.protocolSchemaSha256,
		'protocol.schema.json no longer matches the uws copy at the manifest pin - ' +
		're-vendor it from the pinned commit (or regenerate the manifest if the pin moved)'
	);
});

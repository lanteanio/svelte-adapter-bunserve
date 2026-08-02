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
const { KNOWN_WS_OPTION_KEYS } = await import('../../src/runtime/utils/ws-options.js');

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
	metrics: 'metrics registry',
	metricsSnapshot: 'metrics registry',
	onPressure: 'pressure/protection observability',
	onPublishRate: 'pressure/protection observability',
	pressure: 'pressure/protection observability',
	protection: 'pressure/protection observability',
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
 * Empty against the pinned release: every top-level option uws ships is
 * accepted here. Kept as a list rather than deleted so the next uws release
 * that adds one fails this file instead of passing unnoticed.
 */
const ADAPTER_OPTION_GAPS = {};

/** Top-level adapter options this adapter accepts that uws does not declare. */
const ADAPTER_OPTION_EXTRAS = {
	staticCacheMaxFileSize: 'drift: no equivalent in the pinned uws release'
};

/** `websocket.*` keys uws declares and this adapter does not accept. */
const WS_OPTION_GAPS = {
	adminPath: 'admin endpoint',
	adminAuthAcknowledged: 'admin endpoint',
	authPath: 'auth endpoint',
	authPathRateLimit: 'auth endpoint',
	authPathRateLimitWindow: 'auth endpoint',
	authPathRequireOrigin: 'auth endpoint',
	authorizeWireSubscribe: 'wire-subscribe authorization',
	upgradeAdmission: 'admission control',
	upgradeRateLimit: 'admission control',
	upgradeRateLimitWindow: 'admission control',
	upgradeTimeout: 'admission control',
	consistencyAuditIntervalMs: 'background audits',
	resourceGrowthAuditIntervalMs: 'background audits',
	stateHashIntervalMs: 'background audits',
	metrics: 'pressure/protection observability',
	postureExport: 'pressure/protection observability',
	pressure: 'pressure/protection observability',
	protection: 'pressure/protection observability',
	primaryInit: 'multi-worker clustering',
	workers: 'multi-worker clustering',
	unsafeSameOriginWithoutHostPin: 'origin pinning escape hatch'
};

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
	assertParity(
		'websocket option',
		[...KNOWN_WS_OPTION_KEYS],
		surface.webSocketOptions,
		WS_OPTION_GAPS,
		WS_OPTION_EXTRAS
	);
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

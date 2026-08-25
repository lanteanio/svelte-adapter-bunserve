// Production wiring for publish-egress accounting and ceilings: the outbound
// half of message admission. The account itself - the windowed ledger, the
// ceiling semantics, the tenant resolution - lives in
// utils/egress-account.js; this module binds ONE account per process to the
// runtime's shared state: the per-topic runaway-publisher stats, the window
// counters the pressure sampler drains, the metrics hooks, and the throttled
// refusal and eviction warnings.
//
// Every publish-family fan-out path in platform.js charges here exactly once
// per logical publish, and the optional ceilings refuse a publish BEFORE
// anything authoritative moves - no sequence is stamped, no frame is built,
// nothing reaches the native layer for a refused publish.

import { processMonotonicNow } from '../runtime.js';
import { normalizeEgressOptions, createEgressAccount } from '../utils/egress-account.js';
import { wsModule } from '../ws-handler-bridge.js';
import { ws_options } from './config.js';
import { topicPublishStats, wsCounters, WS_SUBSCRIPTIONS } from './ws-state.js';

export { normalizeEgressOptions, createEgressAccount };
export {
	EGRESS_ADMITTED,
	EGRESS_DEFAULT_WINDOW_MS,
	binaryFrameChargeBytes,
	envelopeWireBytes
} from '../utils/egress-account.js';

/**
 * One account per process, configured at handler-graph start. A holder (not
 * `export let`) so the write is visible to platform.js across modules, and
 * `armed` is one property read on the zero-config hot path.
 *
 * @type {{ armed: boolean, tenantArmed: boolean, bytesArmed: boolean, account: ReturnType<typeof createEgressAccount> | null }}
 */
export const egressGate = { armed: false, tenantArmed: false, bytesArmed: false, account: null };

/**
 * Per-(scope, topic) throttle for the refusal warning, one line per minute
 * per key, FIFO-bounded so a refused high-cardinality topic space cannot turn
 * the throttle table into the leak it exists to prevent.
 * @type {Map<string, number>}
 */
const refusalWarnAt = new Map();
const REFUSAL_WARN_MAX = 512;

/**
 * Per-scope throttle for the eviction warning. Keyed by scope alone: the
 * condition is a fact about how many distinct topics or tenants published
 * inside one window, so naming the unlucky key would point at whichever one
 * happened to be seated next.
 * @type {Map<string, number>}
 */
const evictionWarnAt = new Map();

/**
 * A LIVE usage window was dropped to hold the ledger cap, so that key stops
 * being held to its ceiling for the rest of its window. The counter is the
 * precise measure (`egress_window_evicted_total{scope}`); the throttled line
 * is what a reader gets without a scrape.
 *
 * @param {'topic' | 'tenant'} scope
 */
function reportEviction(scope) {
	wsCounters.egressEvictedByScope[scope]++;
	const t = processMonotonicNow();
	const last = evictionWarnAt.get(scope) || 0;
	if (t - last < 60_000) return;
	evictionWarnAt.set(scope, t);
	console.warn(
		`[ws] the egress ledger dropped a ${scope} usage window that was still counting, so that ` +
		'key is unmetered for the rest of it. This is a cardinality fact, not a capacity one: more ' +
		`distinct ${scope} keys published inside one window than websocket.egress.maxKeys holds. ` +
		'Size maxKeys to the keys live per window (~56 bytes each); the exact count is ' +
		'egress_window_evicted_total.'
	);
}

/**
 * A publish crossed a configured ceiling and was refused: nothing was
 * stamped, serialized or delivered for it. Counted always, said out loud at
 * most once a minute per (scope, topic).
 *
 * @param {'topic' | 'tenant'} scope
 * @param {string | null} topic
 * @param {'messages' | 'bytes' | 'deliveries'} dimension
 * @param {number} limit
 */
function reportRefusal(scope, topic, dimension, limit) {
	if (scope === 'tenant') wsCounters.egressRefusedTenantWindow++;
	else wsCounters.egressRefusedTopicWindow++;
	wsCounters.egressRefusedByScope[scope]++;
	const key = scope + '\0' + (topic === null ? '' : topic);
	const t = processMonotonicNow();
	const last = refusalWarnAt.get(key) || 0;
	if (t - last < 60_000) return;
	if (refusalWarnAt.size >= REFUSAL_WARN_MAX && !refusalWarnAt.has(key)) {
		const oldest = refusalWarnAt.keys().next().value;
		if (oldest !== undefined) refusalWarnAt.delete(oldest);
	}
	refusalWarnAt.set(key, t);
	console.warn(
		`[ws] a publish crossed the websocket.egress ${scope}.${dimension} ceiling (${limit} per ` +
		`window)${topic === null ? '' : ` on topic '${topic}'`} and was refused; nothing was ` +
		'delivered for it. The exact counts are egress_refused_total and the pressure snapshot ' +
		'egress figures.'
	);
}

/** @param {unknown} raw */
function reportResolverInvalid(raw) {
	console.error(
		'[ws] the egressTenantOf resolver returned an unusable id ' +
		`(${raw === null ? 'null' : typeof raw}); publishes are charged unattributed. Ids are ` +
		'1..64 chars of [a-zA-Z0-9_-], and a resolver that throws attributes nothing.'
	);
}

/**
 * Configure this process's egress account. Called once at handler-graph
 * start; a re-run (the simulator's reset) replaces the account and its
 * windows wholesale. `tenantOf` is the handler module's `egressTenantOf`
 * export and must be a function when present - a defined non-function refuses
 * loudly, because reading it as "no resolver" would stand every tenant
 * ceiling down in silence.
 *
 * @param {any} rawOptions - the normalized websocket options' egress section
 * @param {unknown} tenantOf - the handler module's egressTenantOf export
 */
export function configureEgress(rawOptions, tenantOf) {
	if (tenantOf !== undefined && tenantOf !== null && typeof tenantOf !== 'function') {
		throw new TypeError(
			'the egressTenantOf export must be a function (topic) => tenantId | null; got ' + typeof tenantOf
		);
	}
	const options = normalizeEgressOptions(rawOptions);
	const resolver = typeof tenantOf === 'function' ? tenantOf : null;
	const account = createEgressAccount({
		options,
		tenantOf: resolver,
		clock: processMonotonicNow,
		onRefused: reportRefusal,
		onResolverInvalid: reportResolverInvalid,
		onEvicted: reportEviction
	});
	egressGate.account = account;
	egressGate.armed = account.enabled;
	egressGate.tenantArmed = account.tenantEnabled && resolver !== null;
	egressGate.bytesArmed = account.bytesEnabled;
	lastConfigured = { rawOptions, tenantOf: resolver };
	return account;
}

/** What the last configure ran with, so the simulator's reset can replay it. */
/** @type {{ rawOptions: any, tenantOf: ((topic: string) => string | null | undefined) | null } | null} */
let lastConfigured = null;

/**
 * Resolve the tenant a server-side publish on `topic` is charged to, or null
 * when tenant ceilings are unarmed or the topic is unattributed. One memoized
 * map read in the steady state.
 *
 * @param {string} topic
 * @returns {string | null}
 */
export function resolvePublishTenant(topic) {
	if (!egressGate.tenantArmed) return null;
	return /** @type {NonNullable<typeof egressGate.account>} */ (egressGate.account).resolveTenant(topic);
}

/**
 * The pre-hoc admission for one logical publish (or one whole batch). Always
 * true while no ceiling is configured.
 *
 * @param {string | null} topic
 * @param {string | null} tenantId
 * @param {number} messages
 * @param {number} deliveries
 * @returns {boolean}
 */
export function admitPublishEgress(topic, tenantId, messages, deliveries) {
	const account = egressGate.account;
	if (account === null) return true;
	return account.admit(topic, tenantId, messages, deliveries);
}

/**
 * Whether an excluded socket actually holds the topic, i.e. whether the
 * exclusion reduces the recipient count by one. A socket that never
 * subscribed (or whose handle already closed) was never a recipient, so
 * excluding it must not discount the charge.
 *
 * @param {{ getUserData(): any } | null | undefined} ws
 * @param {string} topic
 * @returns {boolean}
 */
export function excludedRecipient(ws, topic) {
	if (ws === null || ws === undefined) return false;
	try {
		const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
		return subs instanceof Set && subs.has(topic);
	} catch {
		return false;
	}
}

/**
 * Charge one admitted logical publish (or one whole admitted batch): the
 * per-topic runaway-publisher stats (their `m`/`b` fields keep their
 * pre-existing meanings; `d` is the additive deliveries dimension), the
 * process egress window counters the pressure sampler drains, and the
 * ceiling account when armed. This is the ONE charge point every
 * publish-family fan-out path calls.
 *
 * @param {string} topic
 * @param {string | null} tenantId
 * @param {number} messages
 * @param {number} deliveries - recipients times messages, exclusions deducted
 * @param {number} envelopeLen - UTF-16 length sum of the JSON envelopes (the
 *   pre-existing `topicPublishStats.b` unit, unchanged)
 * @param {number} wireBytes - total serialized wire bytes (per-recipient size
 *   summed over recipients and messages)
 */
export function chargePublishEgress(topic, tenantId, messages, deliveries, envelopeLen, wireBytes) {
	let s = topicPublishStats.get(topic);
	if (s === undefined) {
		s = { m: 0, b: 0, d: 0 };
		topicPublishStats.set(topic, s);
	}
	s.m += messages;
	s.b += envelopeLen;
	s.d += deliveries;
	wsCounters.egressDeliveriesWindow += deliveries;
	wsCounters.egressBytesWindow += wireBytes;
	const account = egressGate.account;
	if (account !== null && account.enabled) account.charge(topic, tenantId, messages, deliveries, wireBytes);
}

/**
 * Charge a direct (non-publish-stats) fan-out: `sendTo` and
 * `adviseReconnect`. These lanes never touch `topicPublishStats` - the
 * runaway-publisher rates keep meaning publish-family calls - but their
 * frames are egress like any other, so they land in the window counters and,
 * when a topic is present, in the ceiling account.
 *
 * @param {string | null} topic - null for the topic-less reconnect advisory
 * @param {string | null} tenantId
 * @param {number} deliveries
 * @param {number} wireBytes
 */
export function chargeDirectEgress(topic, tenantId, deliveries, wireBytes) {
	wsCounters.egressDeliveriesWindow += deliveries;
	wsCounters.egressBytesWindow += wireBytes;
	const account = egressGate.account;
	if (account !== null && account.enabled) account.charge(topic, tenantId, 1, deliveries, wireBytes);
}

/**
 * The simulator's reset: fresh windows, fresh throttles, the same
 * configuration, so one seed's refusals cannot decide the next seed's and
 * the fingerprint stays a function of the seed alone.
 */
export function _resetEgressForSim() {
	refusalWarnAt.clear();
	evictionWarnAt.clear();
	if (lastConfigured !== null) {
		configureEgress(lastConfigured.rawOptions, lastConfigured.tenantOf);
	}
}

// Armed once at handler-graph start, from the same build-normalized options
// every other once-per-process gate reads (the admission controller's
// pattern) and the handler module's own egressTenantOf export. A missing
// websocket section reads as no ceilings; a defined non-function resolver
// fails the boot here, where the config that named it is closest.
configureEgress(ws_options ? ws_options.egress : undefined, wsModule.egressTenantOf);

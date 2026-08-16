// Deterministic simulation runner: drives the REAL handler dispatch (the same
// modules a built server runs) over an in-memory Bun.serve double, a virtual
// clock and a seeded fault engine, so a seed plus a commit is the entire bug
// report. runSim() explores an interleaving, the same seed reproduces it
// bit-for-bit, and replaySim() self-gates that determinism.
//
// The pure gate layer (swarm / goldens / fingerprints) is deliberately shaped
// like svelte-adapter-uws's, so the two adapters' golden corpora are built and
// checked by one rule. Where uws's sim drives its testing-server MIRROR of the
// production dispatch, this one drives the production modules themselves,
// loaded through the sim-loader hook - strictly the more honest arrangement.
//
// Node-only (module-resolution hook + node:test lane, like every unit gate).
// Internal for now: reached by path from scripts/ and test/, not exported as a
// package subpath.

import { register } from 'node:module';
import { normalizeWsOptions } from './runtime/utils/ws-options.js';
import {
	createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH
} from './runtime/sim-core.js';
import { createInMemoryApp, SIM_ORIGIN } from './runtime/sim-inmemory.js';
import { setRuntimeEnv, resetRuntimeEnv } from './runtime/runtime.js';
import { checkSubscriptionBookkeeping } from './runtime/invariants.js';
import { createConsistencyAuditor } from './runtime/auditor.js';
import { runSteadyState, faultClasses } from './runtime/steadystate.js';

export { createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH };

// The handler graph reads its build-injected config from globals at module
// load, and the WS_HANDLER specifier resolves through the sim loader - both
// must be in place BEFORE the graph is imported, which is why the imports
// below are dynamic and this module has a top-level await. Defaults are only
// installed when a test has not already set its own.
globalThis.ENV_PREFIX ??= '';
globalThis.WS_PATH ??= '/ws';
// A REAL normalized options object, not null: tryUpgrade refuses the upgrade
// lane entirely when ws_options is null, and the sim's whole point is driving
// that lane. allowUnauthenticatedSubscribe matches the posture the sibling
// adapter's sim runs under (its no-gate default allows), so the shared
// default scenario produces comparable structure; a sim run exercising the
// DENY posture passes its own subscribe hook instead.
globalThis.WS_OPTIONS ??= normalizeWsOptions({ allowUnauthenticatedSubscribe: true }).options;
// A resolvable, fixed server origin: config.js reads ORIGIN once at import,
// the same-origin default compares upgrades against it, and the sim's clients
// send the matching Origin header exactly as a browser or the family client
// would (SIM_ORIGIN is the same constant the client double derives its
// Host/Origin headers from). Assigned UNCONDITIONALLY, unlike the globals
// above: an ambient ORIGIN in the shell would win a `??=`, turn every sim
// upgrade cross-origin, and drift the corpus for reasons outside the run.
process.env.ORIGIN = SIM_ORIGIN;

register('./runtime/sim-loader.mjs', import.meta.url);

const { __setSimHooks } = await import('./runtime/sim-hooks.js');
const { websocketHandlers } = await import('./runtime/handler/ws.js');
const { tryUpgrade } = await import('./runtime/handler/upgrade.js');
const { platform } = await import('./runtime/handler/platform.js');
const {
	WS_SUBSCRIPTIONS,
	capCounts,
	envelopePrefixCache,
	lastPublishWarnAt,
	pendingCloseHooks,
	pressureListeners,
	pressureSnapshot,
	publishRateListeners,
	resetDraining,
	resetProcessEpoch,
	resumeBuffers,
	topicPublishStats,
	setServer,
	sharedTopics,
	resetSeqState,
	wsConnections,
	wsCounters
} = await import('./runtime/handler/ws-state.js');
const { upgradeAdmission } = await import('./runtime/handler/admission.js');
const { _resetWireCodecRegistry } = await import('./runtime/handler/codec-registry.js');
const { _resetSharedWireIds } = await import('./runtime/utils/shared-wire-id.js');
const { stopPressureSampling } = await import('./runtime/handler/pressure-metrics.js');

export { resetProcessEpoch };

/**
 * Reset the module-level runtime state a previous run could have left behind -
 * everything the structural fingerprint, the invariant auditor, the
 * steady-state oracles or the replay self-gate can observe. The production
 * runtime is one-server-per-process by design, so the sim - forty seeds in one
 * process - owns the reset explicitly. A miss in anything fingerprint-visible
 * shows up as a determinism failure in replay. The self-gate only polices
 * what it can see, though: MODULE-PRIVATE stderr state across the handler
 * graph (warn-once latches, log throttles) is not reset, so which seed first
 * triggers a given warning - and how a throttle window carries over the
 * clock rewind to the next run's start epoch - depends on swarm order.
 * Accepted, because resetting those would mean harness-only exports sprayed
 * across the production modules; the two warn latches that already ride the
 * exported wsCounters are reset below with the rest of it.
 */
function resetSimState() {
	wsConnections.clear();
	sharedTopics.clear();
	// One call rather than two clears: the seq lane also carries private
	// recency flags, and a flag surviving a reset spares a re-created topic an
	// eviction it never earned.
	resetSeqState();
	resumeBuffers.clear();
	envelopePrefixCache.clear();
	pendingCloseHooks.clear();
	capCounts.clear();
	resetDraining();
	// Nothing in the sim graph starts the sampler today, but a scenario or a
	// test in this process MAY - and a live interval crossing seeds would be
	// exactly the contamination this reset exists to prevent.
	stopPressureSampling();
	_resetWireCodecRegistry();
	_resetSharedWireIds();
	// The upgrade ceiling, on the servers that have one. It is built once per
	// PROCESS from the options, and the sim runs a corpus of servers in one
	// process, so a seed that ended holding a permit would otherwise narrow the
	// ceiling every later seed runs against - and a fingerprint that depends on
	// which seeds ran first is not a fingerprint. Whether the accounting came
	// back is checked as a steady-state hypothesis BEFORE this reset, at the end
	// of each run, so clearing it here hides nothing.
	if (upgradeAdmission !== null) upgradeAdmission._resetForSim();
	wsCounters.closedWsAborts = 0;
	wsCounters.droppedReleaseRecords = 0;
	wsCounters.publishCount = 0;
	wsCounters.totalSubscriptions = 0;
	wsCounters.sendToAsyncWarned = false;
	wsCounters.adviseAsyncWarned = false;
	// The pressure lane. The sampler itself never runs under the sim (nothing
	// starts it), but the publish lanes bump the window counters and per-topic
	// stats on every publish, and a scenario can register listeners or read
	// the snapshot - all cross-seed state without this.
	wsCounters.publishCountWindow = 0;
	wsCounters.lastPublishCount = 0;
	wsCounters.lastConnections = 0;
	wsCounters.lastHeapUsedRatio = 0;
	wsCounters.lastResidentBytes = 0;
	wsCounters.lastBasePressureReason = 'NONE';
	wsCounters.lastSampleWallMs = 0;
	wsCounters.leaseSaturationPeak = 0;
	wsCounters.activePosture = null;
	wsCounters.metricsSampleHook = null;
	wsCounters.postureExportHook = null;
	// Refusal counts are cross-seed state like every counter above: a scenario
	// that drives a refused upgrade would otherwise carry its tally into the next
	// seed's run.
	wsCounters.upgradeRejectedTotal = 0;
	for (const reason of Object.keys(wsCounters.upgradeRejectedByReason)) {
		wsCounters.upgradeRejectedByReason[reason] = 0;
	}
	topicPublishStats.clear();
	lastPublishWarnAt.clear();
	pressureListeners.clear();
	publishRateListeners.clear();
	pressureSnapshot.active = false;
	pressureSnapshot.value = 0;
	pressureSnapshot.subscriberRatio = 0;
	pressureSnapshot.publishRate = 0;
	pressureSnapshot.memoryMB = 0;
	pressureSnapshot.reason = 'NONE';
	pressureSnapshot.maxBufferedBytes = 0;
	pressureSnapshot.backpressuredConnections = 0;
	pressureSnapshot.psi = null;
	pressureSnapshot.cpuThrottle = null;
	pressureSnapshot.topPublishers = [];
}

/**
 * Boot the real dispatch over the injected app double for one run: reset the
 * module state, install the run's app hooks, and point the platform at the
 * double's server.
 *
 * @param {{ handler?: object }} config
 * @param {ReturnType<typeof createInMemoryApp>} app
 */
function createSimServer(config, app) {
	resetSimState();
	__setSimHooks(config.handler || {});
	setServer(app._server);
	return {
		platform,
		async close() {
			// End every live connection through the real close handler; the
			// close-side frames ride the same fault-gated channel.
			for (const raw of [...app._connections]) raw.close(1000, 'sim-teardown');
		}
	};
}

/**
 * Build the plain state snapshot the shared invariant predicate reads from the
 * live in-memory app: per-connection subscribed set (the one fan-out reads)
 * and bookkeeping set (the one counted against the cap), keyed by sim id.
 * `bookkeeping` is null when the userData slot is not a Set, so the shape
 * check in checkSubscriptionBookkeeping fires identically.
 *
 * @param {ReturnType<typeof createInMemoryApp>} app
 */
function buildInvariantSnapshot(app) {
	const connections = [];
	for (const raw of app._connections) {
		const subs = raw.data[WS_SUBSCRIPTIONS];
		connections.push({
			id: raw._simId,
			// Cohort topics (`topic\0bin` / `topic\0json`) live in native
			// membership but NOT in WS_SUBSCRIPTIONS by design; filter them so
			// the bookkeeping predicate compares logical topics to logical
			// topics. `\0` never appears in a user topic.
			subscribed: [...raw._topics].filter((t) => !t.includes('\0')),
			bookkeeping: subs instanceof Set ? [...subs] : null
		});
	}
	return { connections };
}

/** The per-step auditor over the shared predicate (see auditor.js). */
function createSimAuditor(getApp) {
	return createConsistencyAuditor({
		snapshot: () => buildInvariantSnapshot(getApp()),
		assert: () => {},
		fatal: () => {},
		predicates: [checkSubscriptionBookkeeping]
	});
}

/**
 * A deterministic, sorted snapshot of the server's structural state. Sorted so
 * two runs of the same seed produce byte-identical snapshots for the
 * self-gate. Carries NO payload bytes or user data - structure only. Field
 * shape matches the uws sim's snapshot exactly, so fingerprints are computed
 * over the same canonical JSON.
 *
 * @param {ReturnType<typeof createInMemoryApp>} app
 */
function snapshot(app) {
	const connections = [];
	/** @type {Record<string, number>} */
	const topicCounts = {};
	for (const raw of app._connections) {
		const subs = raw.data[WS_SUBSCRIPTIONS];
		const logicalTopics = [...raw._topics].filter((t) => !t.includes('\0'));
		connections.push({
			id: raw._simId,
			subscribed: logicalTopics.slice().sort(),
			bookkeeping: subs instanceof Set ? [...subs].sort() : null
		});
		for (const t of logicalTopics) topicCounts[t] = (topicCounts[t] || 0) + 1;
	}
	connections.sort((a, b) => a.id - b.id);
	/** @type {Record<string, number>} */
	const sortedTopicCounts = {};
	for (const t of Object.keys(topicCounts).sort()) sortedTopicCounts[t] = topicCounts[t];
	return { connections, topicCounts: sortedTopicCounts, openConnections: connections.length };
}

/**
 * The upgrade ceiling's end-of-run reading, or null on a server that has none.
 * Paired with the live socket count, because the hypothesis this feeds is about
 * the two AGREEING rather than about either number alone.
 *
 * @param {ReturnType<typeof createInMemoryApp>} app
 */
function admissionReading(app) {
	if (upgradeAdmission === null) return null;
	return {
		maxConnections: upgradeAdmission.maxConnections,
		inFlight: upgradeAdmission.inFlight,
		connectionPermits: upgradeAdmission.connectionPermits,
		deferredDepth: upgradeAdmission.deferredDepth,
		openConnections: app._connections.size
	};
}

/**
 * The default scenario when a caller passes none: connect N clients, subscribe
 * each to every topic, then publish a few events per topic, advancing the
 * clock between phases so frames flow. Identical steps to the uws sim's
 * default scenario - the golden corpora are only comparable because the
 * workload is.
 */
async function defaultScenario(api, opts) {
	const conns = [];
	for (let i = 0; i < opts.clients; i++) conns.push(api.connect());
	await api.advance();
	for (const c of conns) for (const t of opts.topics) c.subscribe(t);
	await api.advance();
	for (const t of opts.topics) for (let n = 0; n < 3; n++) api.publish(t, 'tick', { n });
	await api.advance();
}

/**
 * The admission scenario: a gated server, an app that refuses some sockets from
 * inside `open`, and clients that leave while the app's `upgrade` hook still has
 * them.
 *
 * These are the two orderings the whole upgrade path is built around, and until
 * this scenario existed no COMMITTED run drove either one - the coverage was
 * unit-level, so the corpus, which is the oracle that does not depend on the
 * code under test, could not fail on them. The defect they produce is not
 * subtle: a permit released twice throws out of the close callback and strands
 * every teardown behind it.
 *
 * The hooks are installed here rather than handed in as `handler` because their
 * state has to be PER RUN. The swarm hands every seed the same config object, so
 * a map of parked resolvers living on it would carry one seed's unfinished
 * handshakes into the next seed's server - cross-seed contamination of exactly
 * the kind resetSimState exists to prevent, and invisible because it would look
 * like a scenario that simply behaved differently later in the corpus.
 *
 * Each client's role is drawn from the run's seeded stream, so the seeds spread
 * across the interleavings rather than all replaying one shape.
 */
async function admissionScenario(api, opts) {
	/** @type {Array<() => void>} resolvers for the handshakes parked in the app hook */
	const parked = [];
	__setSimHooks({
		upgrade(req) {
			const mode = new URL(req.url).searchParams.get('mode') || 'plain';
			// An app hook that AWAITS - a session lookup, a token check, a rate
			// limiter - is what holds a handshake open long enough for its client
			// to leave inside it. Without one the abort branch is unreachable,
			// because nothing is ever pending when the abort arrives.
			if (mode === 'park') return new Promise((resolve) => parked.push(() => resolve({ mode })));
			return { mode };
		},
		open(ws) {
			// `open` is dispatched INSIDE `srv.upgrade`, so this close runs its
			// close callback - and the permit release with it - before the upgrade
			// call returns. Ordinary apps reach it: refusing an unauthenticated
			// session, holding one socket per user, a full room.
			if (ws.getUserData().mode === 'refuse') ws.end(4003, 'refused by the app');
		}
	});

	/** @type {string[]} */
	const modes = [];
	for (let i = 0; i < opts.clients; i++) {
		const draw = api.rng.float();
		modes.push(draw < 0.3 ? 'refuse' : draw < 0.65 ? 'park' : 'plain');
	}

	/** @type {any[]} */
	const conns = [];
	// TWO WAVES, not one burst, and the second wave is the point. A single burst
	// only ever shows the ceiling REFUSING: every handshake is in flight before
	// any permit has come back, so no client is ever admitted because an earlier
	// one released. That is precisely the property a leak destroys - a leaked
	// permit costs nothing until the next client needs it - so a workload that
	// never re-uses a permit cannot fail on one.
	//
	// It also makes both refusal reasons reachable. The two ceilings are checked
	// in order, so in one burst whichever is lower answers every refusal; by the
	// second wave the survivors of the first are holding permits without holding
	// in-flight slots, which is the state where the other one answers.
	const half = Math.ceil(opts.clients / 2);
	for (const [from, to] of [[0, half], [half, opts.clients]]) {
		for (let i = from; i < to; i++) conns[i] = api.connect({ query: 'mode=' + modes[i] });
		await api.advance();

		// The clients that go away mid-handshake. Only the parked ones can: the
		// rest have already been answered by now, and `hangUp()` says so by
		// returning false, which is what keeps this from silently modelling
		// nothing.
		for (let i = from; i < to; i++) {
			if (modes[i] === 'park' && api.rng.float() < 0.5) conns[i].hangUp();
		}
		await api.advance();

		// Whatever is still parked is answered, so the wave can settle. Including
		// the handshakes whose client has already gone: the hook does not know
		// that, and the upgrade path has to be the one that notices.
		for (const release of parked.splice(0)) release();
		await api.advance();
	}

	for (let i = 0; i < conns.length; i++) {
		if (conns[i].state !== 'open') continue;
		for (const t of opts.topics) conns[i].subscribe(t);
	}
	await api.advance();
	// The survivors still carry traffic. A ceiling that refused the right clients
	// but broke the ones it admitted would pass every count and fail here.
	for (const t of opts.topics) for (let n = 0; n < 3; n++) api.publish(t, 'tick', { n });
	await api.advance();
}

/**
 * The scenarios a committed corpus can be blessed against, by NAME.
 *
 * The name is what the corpus file records, because the scenario itself is a
 * function and a function does not survive JSON: a corpus that recorded its
 * workload as `{}` would be re-verified against whatever workload the runner
 * happened to be holding, and the fingerprints would disagree for a reason the
 * report could not name. With the name recorded, that mismatch is reported as
 * one.
 *
 * A scenario supplies its own `handler` hooks where it needs them, so an entry
 * is the whole workload rather than half of one.
 *
 * @type {Record<string, { scenario: (api: any, opts: { clients: number, topics: string[] }) => void | Promise<void> }>}
 */
export const SIM_SCENARIOS = {
	default: { scenario: defaultScenario },
	admission: { scenario: admissionScenario }
};

/**
 * Run one simulation. Single-process only - the cluster path joins when the
 * multi-process backend does.
 *
 * @param {{
 *   seed?: string,
 *   clients?: number,
 *   topics?: string[],
 *   steps?: number,
 *   faults?: object,
 *   handler?: object,
 *   scenario?: (api: any, opts: { clients: number, topics: string[] }) => void | Promise<void>,
 *   tz?: string,
 *   startEpoch?: number,
 *   gitCommit?: string
 * }} [config]
 * @returns {Promise<any>} a SimResult
 */
export async function runSim(config = {}) {
	const seed = config.seed ?? DEFAULT_SEED;
	const clients = config.clients ?? 2;
	const topics = config.topics ?? ['room'];
	const maxSteps = config.steps ?? 100000;

	const rng = createSeededRng(seed);
	const scheduler = createScheduler({ startEpoch: config.startEpoch ?? FIXED_EPOCH, tz: config.tz });
	const faultEngine = createFaultEngine({ rng, faults: config.faults || {} });

	// Install the seeded virtual environment across the seam for the duration
	// of the run, then always restore the native environment. The process
	// epoch LATCHES instead of drawing - the sibling sim's semantics - so the
	// seeded rng stream is not shifted by an epoch draw and every later uuid
	// and fault decision stays stream-aligned across adapters. The latched
	// VALUES differ on the wire: the sibling latches the full epoch-ms, while
	// resetProcessEpoch squeezes it into this adapter's u32 epoch domain. The
	// parity is draw order, not the ack value.
	setRuntimeEnv(scheduler.buildEnv(rng), { force: true });
	resetProcessEpoch(config.startEpoch ?? FIXED_EPOCH);
	try {
		const app = createInMemoryApp({
			scheduler,
			faultEngine,
			dispatch: { websocketHandlers, tryUpgrade, wsPath: globalThis.WS_PATH || '/ws' }
		});
		const server = createSimServer(config, app);

		/** @type {Array<{ category: string, context: any }>} */
		const violations = [];
		const seen = new Set();
		function recordViolation(v) {
			if (!v) return;
			const key = v.category + ':' + JSON.stringify(v.context);
			if (!seen.has(key)) { seen.add(key); violations.push(v); }
		}
		const auditor = createSimAuditor(() => app);

		/** @type {number[]} */
		const clockSamples = [];
		let lastClock = null;
		function observeClock(nowMs) {
			if (nowMs !== lastClock) { clockSamples.push(nowMs); lastClock = nowMs; }
		}
		// The publish-time subscriber set per broadcast, captured when the
		// publish fans out so a later subscribe/unsubscribe cannot make the
		// starvation hypothesis misfire.
		/** @type {Array<{ topic: string, subscribers: number[] }>} */
		const publishLog = [];
		function recordPublish(topic) {
			if (typeof topic !== 'string') return;
			const subscribers = [];
			for (const raw of app._connections) if (raw._topics.has(topic)) subscribers.push(raw._simId);
			publishLog.push({ topic, subscribers });
		}
		function checkInvariants() {
			for (const v of auditor.runOnce()) recordViolation(v);
			observeClock(scheduler.now());
		}

		let totalSteps = 0;
		const clientList = [];
		const api = {
			rng,
			now: () => scheduler.now(),
			server,
			app,
			connect(opts) { const c = app.connect(opts); clientList.push(c); return c; },
			publish: (topic, event, data, opts) => { recordPublish(topic); return server.platform.publish(topic, event, data, opts); },
			async advance(rounds) {
				totalSteps += await scheduler.run({ maxSteps: rounds ?? maxSteps, onStep: checkInvariants });
			}
		};

		const scenario = config.scenario || defaultScenario;
		await scenario(api, { clients, topics });
		// Final drain to quiescence so deferred frames / timers settle.
		const quiesceSteps = await scheduler.run({ maxSteps, onStep: checkInvariants });
		totalSteps += quiesceSteps;
		checkInvariants();
		const drained = quiesceSteps < maxSteps;
		const pendingAtQuiesce = scheduler.pending();

		const finalState = snapshot(app);
		const frames = clientList.reduce((sum, c) => sum + c.frames().length, 0);

		const deliveredPairs = clientList.map((c) => ({
			id: c.serverWs ? c.serverWs._simId : null,
			raw: c.frames(),
			decoded: c.json()
		}));
		for (const v of runSteadyState({
			clockSamples,
			drained,
			pending: pendingAtQuiesce,
			terminal: finalState,
			publishLog,
			clients: deliveredPairs,
			faults: faultClasses(config.faults),
			// Read here, before `server.close()` below tears the connections down:
			// at quiescence the permits and the live sockets must be the same
			// number, and after teardown they are trivially both zero, which is
			// the reading that would prove nothing.
			admission: admissionReading(app)
		})) recordViolation(v);

		await server.close();
		totalSteps += await scheduler.run({ maxSteps, onStep: checkInvariants });

		return {
			seed,
			gitCommit: config.gitCommit ?? (typeof process !== 'undefined' ? process.env.GIT_COMMIT : null) ?? null,
			config: {
				clients,
				topics,
				steps: maxSteps,
				faults: config.faults || {},
				tz: config.tz ?? null,
				startEpoch: config.startEpoch ?? FIXED_EPOCH
			},
			steps: totalSteps,
			virtualTimeMs: scheduler.now() - (config.startEpoch ?? FIXED_EPOCH),
			invariantViolations: violations,
			fatals: [],
			schedulerUncaught: scheduler.uncaught.map((u) => String((u.error && u.error.message) || u.error)),
			metrics: { clients: clientList.length, framesDelivered: frames },
			clientFrames: clientList.map((c) => c.json()),
			finalState,
			_handler: config.handler,
			_scenario: config.scenario,
			_seedConfig: config
		};
	} finally {
		resetRuntimeEnv();
		resetProcessEpoch();
	}
}

/**
 * Re-run a reproducer and assert the same outcome appears - the determinism
 * self-gate. Field set matches the uws sim's replay gate (single-worker
 * subset: fatals stay [], no clusterFrames).
 *
 * @param {any} reproducer a SimResult returned by runSim
 */
export async function replaySim(reproducer) {
	const cfg = {
		...(reproducer._seedConfig || {}),
		seed: reproducer.seed,
		handler: reproducer._handler,
		scenario: reproducer._scenario,
		gitCommit: reproducer.gitCommit
	};
	const result = await runSim(cfg);
	const sameViolations = JSON.stringify(result.invariantViolations) === JSON.stringify(reproducer.invariantViolations);
	const sameState = JSON.stringify(result.finalState) === JSON.stringify(reproducer.finalState);
	const sameFatals = JSON.stringify(result.fatals ?? []) === JSON.stringify(reproducer.fatals ?? []);
	const sameMetrics = JSON.stringify(result.metrics) === JSON.stringify(reproducer.metrics);
	const sameVirtualTime = result.virtualTimeMs === reproducer.virtualTimeMs;
	result.reproduced = sameViolations && sameState && sameFatals && sameMetrics && sameVirtualTime;
	return result;
}

/**
 * Deterministic structural fingerprint of a run: FNV-1a over the byte-stable
 * result fields. IDENTICAL field set and hash to the uws sim's fingerprint,
 * which is what makes cross-adapter corpus comparison meaningful at all.
 *
 * @param {any} result a SimResult
 * @returns {string}
 */
function runFingerprint(result) {
	const canonical = JSON.stringify({
		finalState: result.finalState,
		invariantViolations: result.invariantViolations,
		fatals: result.fatals ?? [],
		clusterFrames: result.clusterFrames ?? null,
		metrics: result.metrics,
		virtualTimeMs: result.virtualTimeMs
	});
	let h = 2166136261 >>> 0;
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** The failure oracle for one run. */
function runFailed(result) {
	return (result.invariantViolations && result.invariantViolations.length > 0)
		|| (result.fatals && result.fatals.length > 0)
		|| (result.schedulerUncaught && result.schedulerUncaught.length > 0);
}

/**
 * Run a swarm of seeds and aggregate pass/fail plus a reproduce key for each
 * failing seed. Same knobs and per-seed derived rng streams as the uws swarm
 * (seed+':faultmode', seed+':check'), so a corpus records the same faulted
 * subset for the same seed range.
 *
 * @param {{
 *   seeds?: Array<string | number>,
 *   count?: number,
 *   startSeed?: number,
 *   base?: object,
 *   faultMode?: 'off' | 'on' | 'random',
 *   faultProfile?: object,
 *   faultProbability?: number,
 *   checkRatio?: number,
 *   gitCommit?: string,
 *   scenarioName?: string,
 *   onResult?: (run: any, index: number) => void
 * }} [config]
 * @returns {Promise<{ summary: any, runs: any[] }>}
 */
export async function runSimSwarm(config = {}) {
	const base = config.base || {};
	const faultMode = config.faultMode || 'off';
	const faultProbability = config.faultProbability ?? 0.25;
	const checkRatio = config.checkRatio ?? 0;
	const faultProfile = config.faultProfile || {};

	let seeds;
	if (Array.isArray(config.seeds)) {
		seeds = config.seeds.map(String);
	} else {
		const startSeed = Number.isInteger(config.startSeed) ? config.startSeed : 1;
		const count = Number.isInteger(config.count) ? config.count : 50;
		seeds = [];
		for (let i = 0; i < count; i++) seeds.push(String(startSeed + i));
	}

	const runs = [];
	const failingSeeds = [];
	const determinismFailingSeeds = [];
	let determinismChecks = 0;
	let gitCommit = config.gitCommit ?? base.gitCommit ?? null;

	for (let i = 0; i < seeds.length; i++) {
		const seed = seeds[i];
		let faulted = faultMode === 'on';
		if (faultMode === 'random') faulted = createSeededRng(seed + ':faultmode').float() < faultProbability;
		const faults = faulted ? { ...(base.faults || {}), ...faultProfile } : (base.faults || {});

		const result = await runSim({ ...base, seed, faults });
		if (gitCommit === null) gitCommit = result.gitCommit;

		const failed = runFailed(result);

		let reproduced = null;
		if (checkRatio > 0 && createSeededRng(seed + ':check').float() < checkRatio) {
			determinismChecks++;
			reproduced = (await replaySim(result)).reproduced === true;
			if (!reproduced) determinismFailingSeeds.push(seed);
		}

		const run = {
			seed,
			ok: !failed && reproduced !== false,
			faulted,
			fingerprint: runFingerprint(result),
			violations: (result.invariantViolations || []).length,
			fatals: (result.fatals || []).length,
			uncaught: (result.schedulerUncaught || []).length,
			violationCategories: [...new Set((result.invariantViolations || []).map((v) => v.category))].sort(),
			reproduced
		};
		runs.push(run);
		if (failed) failingSeeds.push(seed);
		if (config.onResult) config.onResult(run, i);
	}

	const determinismFailures = determinismFailingSeeds.length;
	const summary = {
		total: seeds.length,
		passed: runs.filter((r) => r.ok).length,
		failed: failingSeeds.length,
		firstFailingSeed: failingSeeds.length ? failingSeeds[0] : null,
		failingSeeds,
		faultMode,
		// Which named workload produced these fingerprints. Carried so the corpus
		// can record it and a later run can be told it is comparing against a
		// different one; null when the caller ran an unnamed scenario of its own.
		scenarioName: config.scenarioName ?? null,
		faulted: runs.filter((r) => r.faulted).length,
		determinismChecks,
		determinismFailures,
		determinismFailingSeeds,
		gitCommit,
		ok: failingSeeds.length === 0 && determinismFailures === 0
	};
	return { summary, runs };
}

/** Numeric-aware seed comparator: "2" sorts before "10". */
function compareSeeds(a, b) {
	const na = Number(a);
	const nb = Number(b);
	const aNum = Number.isFinite(na);
	const bNum = Number.isFinite(nb);
	if (aNum && bNum) return na - nb || String(a).localeCompare(String(b));
	if (aNum) return -1;
	if (bNum) return 1;
	return String(a).localeCompare(String(b));
}

/**
 * Project a swarm result into a committable golden corpus. Same schema
 * (schemaVersion 1) and entry shape as the uws corpus builder.
 *
 * @param {{ summary: any, runs: any[] }} swarmResult
 * @param {{ weights?: Record<string, number>, gitCommit?: string|null, recordedAt?: string|null, swarm?: object|null }} [opts]
 */
export function buildSimGoldens(swarmResult, opts = {}) {
	const weights = opts.weights || {};
	const entries = swarmResult.runs.map((r) => ({
		seed: String(r.seed),
		weight: weights[r.seed] ?? weights[String(r.seed)] ?? 1,
		fingerprint: r.fingerprint,
		digest: {
			violations: r.violations,
			fatals: r.fatals,
			uncaught: r.uncaught,
			violationCategories: r.violationCategories,
			faulted: r.faulted
		}
	}));
	entries.sort((a, b) => compareSeeds(a.seed, b.seed));
	return {
		schemaVersion: 1,
		gitCommit: opts.gitCommit ?? swarmResult.summary?.gitCommit ?? null,
		recordedAt: opts.recordedAt ?? null,
		swarm: opts.swarm ?? null,
		entries
	};
}

/**
 * Compare a golden corpus against a fresh swarm result, weighting each drifted
 * seed by its recorded weight. Pure; same gate rule as the uws checker
 * (config-mismatch fails loudly, driftWeight over maxDriftWeight fails, an
 * intentional change is blessed by regenerating the corpus).
 *
 * @param {any} golden
 * @param {{ summary: any, runs: any[] }} swarmResult
 * @param {{ maxDriftWeight?: number }} [opts]
 */
export function checkSimGoldens(golden, swarmResult, opts = {}) {
	const maxDriftWeight = opts.maxDriftWeight ?? 0;
	const actual = new Map();
	for (const r of swarmResult.runs) actual.set(String(r.seed), r);

	let configMismatch = null;
	const gFaultMode = golden.swarm ? golden.swarm.faultMode : undefined;
	const aFaultMode = swarmResult.summary ? swarmResult.summary.faultMode : undefined;
	if (gFaultMode !== undefined && gFaultMode !== null && aFaultMode !== undefined && gFaultMode !== aFaultMode) {
		configMismatch = "fault mode differs: corpus recorded '" + gFaultMode + "', run used '" + aFaultMode +
			"' - fingerprints are not comparable; regenerate the corpus or fix the runner config";
	}
	// The workload, on the same rule as the fault mode above. Without this a
	// corpus checked against the wrong scenario reports drift on every seed, which
	// reads as forty regressions in the code rather than as one wrong runner
	// config - and the two call for opposite responses.
	const gScenario = golden.swarm ? golden.swarm.scenario : undefined;
	const aScenario = swarmResult.summary ? swarmResult.summary.scenarioName : undefined;
	if (configMismatch === null && gScenario !== undefined && gScenario !== null && aScenario !== undefined && aScenario !== null && gScenario !== aScenario) {
		configMismatch = "scenario differs: corpus recorded '" + gScenario + "', run used '" + aScenario +
			"' - fingerprints are not comparable; regenerate the corpus or fix the runner config";
	}

	const drifts = [];
	let changed = 0;
	let missing = 0;
	let matched = 0;
	let totalWeight = 0;
	let driftWeight = 0;
	for (const entry of golden.entries) {
		const w = entry.weight ?? 1;
		totalWeight += w;
		const a = actual.get(String(entry.seed));
		if (!a) {
			missing++;
			driftWeight += w;
			drifts.push({ seed: entry.seed, weight: w, kind: 'missing', golden: { fingerprint: entry.fingerprint, digest: entry.digest }, actual: null });
			continue;
		}
		if (a.fingerprint === entry.fingerprint) {
			matched++;
		} else {
			changed++;
			driftWeight += w;
			drifts.push({
				seed: entry.seed,
				weight: w,
				kind: 'changed',
				golden: { fingerprint: entry.fingerprint, digest: entry.digest },
				actual: {
					fingerprint: a.fingerprint,
					digest: { violations: a.violations, fatals: a.fatals, uncaught: a.uncaught, violationCategories: a.violationCategories, faulted: a.faulted }
				}
			});
		}
	}

	let added = 0;
	const goldenSeeds = new Set(golden.entries.map((e) => String(e.seed)));
	for (const r of swarmResult.runs) if (!goldenSeeds.has(String(r.seed))) added++;

	drifts.sort((x, y) => (y.weight - x.weight) || compareSeeds(x.seed, y.seed));
	const ok = configMismatch === null && driftWeight <= maxDriftWeight;
	return { ok, totalWeight, driftWeight, maxDriftWeight, drifts, configMismatch, counts: { changed, missing, added, matched } };
}

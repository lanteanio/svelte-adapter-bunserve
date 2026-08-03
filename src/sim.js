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
	maxAuthoritativeSeq,
	pendingCloseHooks,
	resetDraining,
	resetProcessEpoch,
	resumeBuffers,
	setServer,
	sharedTopics,
	topicSeqs,
	wsConnections,
	wsCounters
} = await import('./runtime/handler/ws-state.js');
const { _resetWireCodecRegistry } = await import('./runtime/handler/codec-registry.js');
const { _resetSharedWireIds } = await import('./runtime/utils/shared-wire-id.js');

export { resetProcessEpoch };

/**
 * Reset the module-level runtime state a previous run could have left behind -
 * everything the structural fingerprint, the invariant auditor, the
 * steady-state oracles or the replay self-gate can observe. The production
 * runtime is one-server-per-process by design, so the sim - forty seeds in one
 * process - owns the reset explicitly. A miss in anything fingerprint-visible
 * shows up as a determinism failure in replay. The self-gate only polices
 * what it can see, though: stderr-lane state (warn-once latches, log
 * throttles) is deliberately not reset, so which seed first triggers a given
 * warning depends on swarm order - accepted, because resetting it would mean
 * harness-only exports sprayed across the production modules.
 */
function resetSimState() {
	wsConnections.clear();
	sharedTopics.clear();
	maxAuthoritativeSeq.clear();
	topicSeqs.clear();
	resumeBuffers.clear();
	envelopePrefixCache.clear();
	pendingCloseHooks.clear();
	capCounts.clear();
	resetDraining();
	_resetWireCodecRegistry();
	_resetSharedWireIds();
	wsCounters.closedWsAborts = 0;
	wsCounters.droppedReleaseRecords = 0;
	wsCounters.publishCount = 0;
	wsCounters.totalSubscriptions = 0;
	wsCounters.sendToAsyncWarned = false;
	wsCounters.adviseAsyncWarned = false;
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
 * Run one simulation. Single-process only - the cluster path joins when the
 * multi-process slice lands, per the recorded scope.
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
			faults: faultClasses(config.faults)
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

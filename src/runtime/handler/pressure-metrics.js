// The 1 Hz pressure sampler: reads the worker's counters, folds them into the
// live pressureSnapshot, and fires the pressure/publish-rate listeners. The
// sibling adapter's module of the same name also carries bumpIn/bumpOut (here
// in ws-stats.js), the topic-registry cardinality warning (superseded here by
// the seq-topic eviction warning in ws-state.js - this adapter caps the
// registry at MAX_SEQ_TOPICS, so the sibling's million-topic threshold is
// unreachable), and the publishBatched frame-size warning (no publishBatched
// lane exists here).

import { computePressureReason, computeTopPublishers, applyCapacityReason } from '../utils/pressure.js';
import { foldConnectionBackpressure, BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES } from '../utils/backpressure.js';
import { DEFAULT_GRANT, leaseGrantSize, samplePressureValue } from '../utils/lease.js';
import { now, setIntervalTimer, clearIntervalTimer, subscribeMemoryPressure } from '../runtime.js';
import { createOsPressureSampler } from '../utils/os-pressure.js';
import { sweepRateLimits } from './rate-limit.js';
import { processMemoryWall } from '../utils/memory-wall.js';
import { PRESSURE_INTERVAL_MAX_MS, PRESSURE_INTERVAL_MIN_MS } from '../utils/ws-options.js';
import {
	lastPublishWarnAt,
	pressureListeners,
	pressureSnapshot,
	publishRateListeners,
	topicPublishStats,
	wsConnections,
	wsCounters
} from './ws-state.js';

// Kernel pressure sources (PSI + cgroup CPU quota), sampled on the same 1 Hz
// tick as the process-local counters. Probes once; on hosts without the
// source (non-Linux, PSI compiled out, no cgroup limits) the sampler returns
// nulls at zero further cost and the pressure math is byte-identical.
const osPressure = createOsPressureSampler();

/**
 * Bound on the runaway-publisher warn-dedup map. Pure dedup state, so
 * FIFO-evicting at the cap just resets a topic's warn throttle - no
 * correctness impact - while an unbounded-cardinality publisher cannot grow
 * the map without limit.
 */
// Matches the sibling's bound. Deliberately far past any real topic
// cardinality, which also means no test drives the eviction below it - the
// bound is a backstop against an unbounded-cardinality publisher, not a path
// the suite can reach without building a million-entry map.
const PUBLISH_WARN_DEDUP_MAX = 1_000_000;

/** @type {ReturnType<typeof setIntervalTimer> | null} */
let pressureTimer = null;
/** @type {(() => void) | null} */
let stopMemoryHint = null;

/**
 * Default pressure thresholds. Designed to be safe rather than tight: the
 * goal is "no false positives in the steady state of a healthy small app,"
 * not "perfectly tuned for sustained five-figure publish rates." Override
 * per-deployment via the `pressure` field on the WebSocket options.
 */
/**
 * The memory-wall reader, the process's one. The `heap_used_ratio` gauge
 * publishes this sampler's reading; only on a build with no WebSocket tier
 * does the metrics scrape read the reader itself. Stateful: it sweeps the cgroup
 * limit files of the process's group and its ancestors on each read, reads
 * the group list itself only when due, and stands a file that fails to read
 * at its last value. Nothing here sits on a frame path.
 */
const pressureSources = {
	memoryWall: processMemoryWall,
	osPressure,
	memoryUsage: () => process.memoryUsage()
};

const DEFAULT_PRESSURE_THRESHOLDS = {
	// The family default, on both adapters, now that the reading underneath it
	// means the same thing on both engines. It was OFF here while the basis was
	// arena fullness: JavaScriptCore fits heapTotal close to heapUsed, so an
	// idle server measured 0.90-0.94 on Bun 1.3.14 and 0.81 on 1.4.0 - against
	// 0.85 the signal fired on an idle 1.3 process and never cleared, and on
	// 1.4 idled a whisker under it where ordinary churn crossed it with no
	// pressure behind it. The basis is distance to the nearest memory WALL now
	// (utils/memory-wall.js), which idles near zero on both engines, so the
	// threshold measures what it always claimed to.
	memoryHeapUsedRatio: 0.85,
	publishRatePerSec: 10000,
	subscriberRatio: 50,
	sampleIntervalMs: 1000,
	// Per-topic runaway-publisher thresholds. A topic that crosses
	// either of these in a sample window fires the configured callback
	// (or a throttled console.warn by default). Both can be set to
	// false to disable per-topic tracking entirely.
	topicPublishRatePerSec: 5000,
	topicPublishBytesPerSec: 10 * 1024 * 1024,
	// Kernel pressure thresholds, active only where the source exists
	// (/proc/pressure on a PSI-enabled Linux kernel; cgroup cpu.stat inside
	// a quota-limited container) - on any other host the sample fields are
	// absent and these never fire. PSI values are avg10 percentages of
	// wall time stalled: cpu 'some' 60% means most of the last 10s had at
	// least one runnable task waiting for a CPU; memory/io use the 'full'
	// line (everyone stalled at once - thrash / device saturation), which
	// fires meaningfully earlier than an OOM-adjacent heap ratio.
	// cpuThrottledRatio is the fraction of the sample window the CFS quota
	// held the whole process suspended.
	psiCpuSome: 60,
	psiMemoryFull: 15,
	psiIoFull: 50,
	cpuThrottledRatio: 0.25
};

/**
 * Sample once: read counters, fold them into the snapshot, fire listeners
 * iff `reason` changed. Called by the 1 Hz timer; a test drives it by
 * installing a runtime env whose interval timer hands back the callback.
 *
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false, sampleIntervalMs: number, topicPublishRatePerSec: number | false, topicPublishBytesPerSec: number | false }} thresholds
 */
function samplePressure(thresholds, sources) {
	const interval = thresholds.sampleIntervalMs / 1000;
	const publishRate = interval > 0 ? wsCounters.publishCountWindow / interval : 0;
	// Retain the raw window count before it is zeroed. The metrics hook exports
	// it as a monotonic counter rather than re-exporting `publishRate`: a
	// precomputed rate is only readable at the sampler's own cadence, while a
	// counter lets the query choose its window and survives a scrape interval
	// that does not match ours.
	wsCounters.lastPublishCount = wsCounters.publishCountWindow;
	wsCounters.publishCountWindow = 0;

	// Drain the egress window into the snapshot the same way: the counters
	// accumulate between ticks, the snapshot carries the last whole window.
	pressureSnapshot.egress = {
		deliveries: wsCounters.egressDeliveriesWindow,
		bytes: wsCounters.egressBytesWindow,
		refusedTopic: wsCounters.egressRefusedTopicWindow,
		refusedTenant: wsCounters.egressRefusedTenantWindow
	};
	wsCounters.egressDeliveriesWindow = 0;
	wsCounters.egressBytesWindow = 0;
	wsCounters.egressRefusedTopicWindow = 0;
	wsCounters.egressRefusedTenantWindow = 0;

	const connections = wsConnections.size;
	wsCounters.lastConnections = connections;
	const subscriberRatio = connections > 0 ? wsCounters.totalSubscriptions / connections : 0;

	// Aggregate outbound backpressure across a bounded sample of the live
	// connections. `getBufferedAmount()` is one native call per connection;
	// the walk is capped at BACKPRESSURE_SAMPLE_CAP so a worker holding tens
	// of thousands of sockets pays a fixed per-tick cost. This is the ONLY
	// per-connection iteration the sampler performs and it never runs on the
	// publish path (Bun fans out natively; this reads a coarse 1 Hz health
	// gauge). The fold is zero-alloc and unit-tested in isolation. The set
	// holds facades, whose getBufferedAmount throws once closed - the fold
	// counts a throw as 0, exactly the already-gone case.
	const { maxBufferedBytes, backpressuredConnections } = foldConnectionBackpressure(
		wsConnections, BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES
	);

	// Production reads the real process. Controlled runs inject both memory
	// sources and notifications so host conditions cannot shape their trace.
	const mem = sources.memoryUsage();
	// DISTANCE TO THE NEAREST MEMORY WALL, not arena fullness. `heapUsed /
	// heapTotal` measures how tightly the engine keeps its arena fitted, which
	// is not memory pressure and on this runtime is close to its inverse:
	// JavaScriptCore fits the arena to usage, so an idle server read 0.90-0.94
	// and the ratio FELL as the arena grew. The MEMORY signal fired on a
	// sleeping process and could not see the kill that actually happens - the
	// kernel's OOM killer charges the resident set against the cgroup limit,
	// which no heap ratio observes.
	//
	// The family contract (svelte-adapter-uws docs/architecture.md#memory-pressure-signal)
	// is the worst of two walls, each measured with the quantity its wall kills
	// on. JavaScriptCore reports no allocation ceiling, so the engine arm is
	// absent here and the container arm carries the reading; with no wall on
	// either arm the signal degrades to silence rather than to a false alarm.
	// The option name and its default are unchanged, and one reading feeds the
	// MEMORY reason, the value fold, the gauge and the grant sizing, so no
	// consumer is calibrated against a different basis.
	const measuredHeapUsedRatio = sources.memoryWall.measure(mem);
	const heapUsedRatio = measuredHeapUsedRatio ?? 0;
	const memoryMB = mem.rss / (1024 * 1024);
	// Retained for the consumers that read between ticks: the send-gate window
	// sizer and the heap_used_ratio gauge.
	wsCounters.lastHeapUsedRatio = heapUsedRatio;
	wsCounters.lastMeasuredHeapUsedRatio = measuredHeapUsedRatio;

	// Kernel signals for this window. Null per source when unavailable; the
	// sample fields stay absent then, so every downstream comparison and the
	// saturation fold skip them without a branch of their own.
	const os = sources.osPressure.sample(thresholds.sampleIntervalMs);
	/** @type {{ heapUsedRatio: number, publishRate: number, subscriberRatio: number, psiCpuSome10?: number, psiMemoryFull10?: number, psiIoFull10?: number, cpuThrottledRatio?: number }} */
	const sampleReadings = { heapUsedRatio, publishRate, subscriberRatio };
	if (os.psi !== null) {
		sampleReadings.psiCpuSome10 = os.psi.cpuSome10;
		sampleReadings.psiMemoryFull10 = os.psi.memoryFull10;
		sampleReadings.psiIoFull10 = os.psi.ioFull10;
	}
	if (os.cpuThrottle !== null) {
		sampleReadings.cpuThrottledRatio = os.cpuThrottle.throttledRatio;
	}

	// Drain per-topic counters into per-second rates. The pure helper
	// reads but does not mutate; we clear the source map after to start
	// the next window fresh.
	const { topPublishers, overThreshold } = computeTopPublishers(
		topicPublishStats, interval, thresholds
	);
	topicPublishStats.clear();

	const reason = computePressureReason(sampleReadings, thresholds);
	wsCounters.lastBasePressureReason = reason;
	// Layer the protection posture's CAPACITY reason on top of the pure
	// pressure reason. When no posture is engaged this is byte-identical to
	// the base reason. The level read here is the one the gate enforced during
	// the window just measured; the posture advances for the NEXT sample below.
	const effectiveReason = wsCounters.activePosture !== null
		? applyCapacityReason(reason, wsCounters.activePosture.level)
		: reason;

	// Fold a worker-global 0..1 saturation scalar into `value`. Each active
	// threshold contributes its sample's distance toward the threshold
	// (worst-of), clamped to 0..1; a fully healthy worker reads 0. The worst
	// per-connection send-gate reading observed since the last sample is
	// folded in worst-of too, so a saturated opted-in connection lifts the
	// worker value even while the global counters look calm. The peak is then
	// decayed so a single spike does not stick across samples.
	const value = samplePressureValue(
		sampleReadings,
		thresholds,
		wsCounters.leaseSaturationPeak
	);
	wsCounters.leaseSaturationPeak *= 0.5;

	const transitioned = effectiveReason !== pressureSnapshot.reason;
	if (transitioned) {
		// Counted HERE, where the previous reason is still readable, rather than
		// below with the listener dispatch - by then the snapshot has been
		// overwritten and only the destination would be knowable. One Map write
		// per transition, on a path that already writes the whole snapshot, and
		// the key space is the reason vocabulary squared.
		const key = pressureSnapshot.reason + '>' + effectiveReason;
		wsCounters.pressureReasonTransitions.set(
			key,
			(wsCounters.pressureReasonTransitions.get(key) ?? 0) + 1
		);
	}
	pressureSnapshot.value = value;
	pressureSnapshot.subscriberRatio = subscriberRatio;
	pressureSnapshot.publishRate = publishRate;
	pressureSnapshot.memoryMB = memoryMB;
	pressureSnapshot.reason = effectiveReason;
	pressureSnapshot.active = effectiveReason !== 'NONE';
	pressureSnapshot.topPublishers = topPublishers;
	// Aggregate outbound-queue telemetry from the bounded walk above.
	// maxBufferedBytes is the worst per-connection queue depth seen this tick
	// (compare against maxBackpressure, 1 MB default, to gauge headroom before
	// the backend sheds); backpressuredConnections is how many sampled sockets
	// are holding a notable queue. Both read 0 in the healthy steady state.
	pressureSnapshot.maxBufferedBytes = maxBufferedBytes;
	pressureSnapshot.backpressuredConnections = backpressuredConnections;
	// Kernel readings ride the snapshot (platform.pressure and the export
	// hooks) as small stable objects; null when unavailable.
	pressureSnapshot.psi = os.psi;
	pressureSnapshot.cpuThrottle = os.cpuThrottle;

	// Advance the posture once per sample, AFTER folding the snapshot - the
	// level just read drove this sample's reason; the tick decides the next.
	// Rides the existing pressure timer, so no new timer is introduced. The
	// posture must read the BASE pressure signal, not the CAPACITY-layered one:
	// once the level is engaged, `effectiveReason` is forced to CAPACITY every
	// sample, so feeding the layered activity back would mean the relaxation
	// dwell never sees a calm sample and the level could never relax. The base
	// `reason` is the true load signal that drives both directions.
	if (wsCounters.activePosture !== null) wsCounters.activePosture.tick({ active: reason !== 'NONE' });

	// Stamp the fold as complete BEFORE the hook publishes it, so the freshness
	// gauge dates the sample it is exported with rather than the previous one.
	wsCounters.lastSampleWallMs = now();

	// Sample the admission gauges on the same cadence. Null unless a metrics
	// registry is configured, so the zero-config sampler is unchanged.
	if (wsCounters.metricsSampleHook !== null) wsCounters.metricsSampleHook();

	// Push the posture line to export subscribers on the same cadence (the
	// 1 Hz heartbeat is the export contract: silence means the adapter is
	// gone). Null unless a posture export is configured.
	if (wsCounters.postureExportHook !== null) wsCounters.postureExportHook();

	if (transitioned) {
		// SNAPSHOT, not the live Set. A listener that registers a listener from
		// inside its own callback extends the very sweep it is running in, and a
		// Set iterator visits entries added during iteration - so one such
		// listener turns a bounded fan-out into an unbounded one, inside the 1 Hz
		// sampler. Allocation only on a transition, which is rare by construction.
		for (const cb of [...pressureListeners]) {
			try {
				cb(pressureSnapshot);
			} catch (err) {
				console.error('[pressure] listener threw:', err);
			}
		}
	}

	if (overThreshold.length > 0) {
		if (publishRateListeners.size > 0) {
			// Snapshotted for the reason the pressure sweep above is, and
			// allocated only when a topic is actually over its threshold.
			for (const cb of [...publishRateListeners]) {
				try {
					cb(overThreshold);
				} catch (err) {
					console.error('[pressure] publish-rate listener threw:', err);
				}
			}
		} else {
			// Default: throttled console.warn per topic so a sustained
			// runaway does not flood the log. Suppressed entirely when
			// the user has registered an onPublishRate callback - they
			// own the surface at that point.
			const t = now();
			for (const e of overThreshold) {
				const last = lastPublishWarnAt.get(e.topic) || 0;
				if (t - last < 60_000) continue;
				// FIFO-evict the oldest entry once at cap. Pure dedup
				// state, so dropping the oldest just resets the warn
				// throttle for that topic on its next over-threshold
				// publish - no correctness impact.
				if (lastPublishWarnAt.size >= PUBLISH_WARN_DEDUP_MAX && !lastPublishWarnAt.has(e.topic)) {
					const oldest = lastPublishWarnAt.keys().next().value;
					if (oldest !== undefined) lastPublishWarnAt.delete(oldest);
				}
				lastPublishWarnAt.set(e.topic, t);
				console.warn(
					'[ws] runaway publisher topic=%s msg/s=%d bytes/s=%d\n  See: https://svti.me/pressure',
					e.topic, Math.round(e.messagesPerSec), Math.round(e.bytesPerSec)
				);
			}
		}
	}

	// Retire rate-limit identities that have gone quiet. It rides this tick
	// rather than owning a timer for the reason the posture advance above does:
	// the process already wakes on this schedule, and a second interval for work
	// this cheap is a second thing to start, stop and reason about at shutdown.
	// A server with no limiter configured does nothing here.
	sweepRateLimits();
}

/**
 * Size the next send-gate window for an opted-in connection: memory headroom
 * and per-connection subscriber load narrow the window, so a worker near a
 * wall or carrying heavy fan-out hands out smaller ones. Zero-config; never
 * user exposed. Always floors to a window large enough that a connection
 * makes forward progress, and costs no syscall - the readings it needs are
 * bookkeeping this process already keeps.
 *
 * The heap reading is the sampler's cached ratio, never a live
 * `process.memoryUsage()`: this runs per inbound `request-n` frame, so a
 * syscall here would sit on the replenish hot path, and a live read would
 * make grant sizes depend on the host heap while every other input under the
 * sim is virtualized through the deterministic seam. Its staleness is the
 * sample interval, so a configured `sampleIntervalMs` is also how old a
 * window's memory reading may be; before the first sample, and throughout the
 * sim, which starts no sampler, the cache reads 0 and the full base window is
 * handed out.
 *
 * @returns {{ count: number, ttlMs: number }}
 */
export function grantSizeFor() {
	// Distance to the nearest memory wall, the same reading the MEMORY
	// threshold and the value fold take, so no consumer is calibrated against
	// a different basis. WHERE A WALL EXISTS it idles near zero and the 0.7
	// knee inside leaseGrantSize is crossed by a worker actually approaching
	// an out-of-memory death - which an arena-fullness reading cannot tell
	// apart on this engine, where an idle server measures 0.90 to 0.94 on Bun
	// 1.3.14 and 0.81 on 1.4.0.
	//
	// Where NO wall is discoverable this reads 0 and contributes nothing,
	// which is the contract (utils/memory-wall.js): this engine reports no
	// allocation ceiling, so the cgroup arm carries the reading alone, and a
	// process with no memory limit on its cgroup or any ancestor has no wall
	// to measure a distance to. The signal degrades to silence rather than to
	// a fabricated one, and the window is then sized by subscriber load alone.
	// So this narrows windows only where a memory limit applies - a limited
	// container, or a service given one (systemd MemoryMax=) - and since the
	// reader keeps looking on any host with cgroups, a limit set on a running
	// process takes effect. Without one the memory term is inert and the
	// fan-out term is the whole sizer.
	const heapRatio = wsCounters.lastHeapUsedRatio;
	const conns = wsConnections.size || 1;
	const subRatio = wsCounters.totalSubscriptions / conns;
	const count = leaseGrantSize({ heapRatio, subscriberRatio: subRatio });
	return { count, ttlMs: DEFAULT_GRANT.ttlMs };
}

/**
 * Merge user-supplied pressure options on top of the safe defaults. Each
 * threshold accepts `false` to disable that signal. `sampleIntervalMs` is
 * clamped at both ends: under the minimum it resets to the default rather
 * than spinning, and past the timer ceiling it caps, because a delay larger
 * than that silently becomes 1ms on both runtimes - which would turn a
 * config asking for RARE samples into the tightest possible loop.
 *
 * @param {{ memoryHeapUsedRatio?: number | false, publishRatePerSec?: number | false, subscriberRatio?: number | false, sampleIntervalMs?: number, topicPublishRatePerSec?: number | false, topicPublishBytesPerSec?: number | false } | undefined} opts
 */
export function resolvePressureThresholds(opts) {
	const merged = { ...DEFAULT_PRESSURE_THRESHOLDS, ...(opts || {}) };
	if (typeof merged.sampleIntervalMs !== 'number' || merged.sampleIntervalMs < PRESSURE_INTERVAL_MIN_MS) {
		merged.sampleIntervalMs = DEFAULT_PRESSURE_THRESHOLDS.sampleIntervalMs;
	} else if (merged.sampleIntervalMs > PRESSURE_INTERVAL_MAX_MS) {
		// Past this a timer delay silently becomes 1ms on both runtimes, so a
		// config asking for a rare sample would get a ~1 kHz one. Cap instead.
		merged.sampleIntervalMs = PRESSURE_INTERVAL_MAX_MS;
	}
	return merged;
}

/**
 * Start the 1 Hz pressure sampler. Idempotent: a second call replaces the
 * existing timer with a new one using the supplied thresholds. The timer is
 * unref'd so it never holds the process open; the freshness consequence is
 * observable via `lastSampleWallMs`.
 *
 * @param {Parameters<typeof resolvePressureThresholds>[0]} opts
 */
let testPressureSources = null;

// Internal sampler seam; the public simulation environment does not accept it.
export function setPressureSourcesForTest(sources) {
	testPressureSources = sources;
}

export function startPressureSampling(opts) {
	const thresholds = resolvePressureThresholds(opts);
	stopPressureSampling();
	const controlled = testPressureSources;
	const sources = controlled ? { ...pressureSources, ...controlled } : pressureSources;
	let active = true;
	let pending = false;
	const detach = (controlled?.subscribe ?? subscribeMemoryPressure)(level => {
		if (active && (level === 'warning' || level === 'critical')) pending = true;
	});
	stopMemoryHint = () => { active = false; pending = false; if (typeof detach === 'function') detach(); };
	try {
		pressureTimer = setIntervalTimer(() => {
			if (!active) return;
			if (pending) {
				pending = false;
				sources.memoryWall.refresh();
			}
			samplePressure(thresholds, sources);
		}, thresholds.sampleIntervalMs);
		if (pressureTimer && typeof pressureTimer.unref === 'function') pressureTimer.unref();
	} catch (error) {
		stopPressureSampling();
		throw error;
	}
}

export function stopPressureSampling() {
	if (stopMemoryHint) {
		const stop = stopMemoryHint;
		stopMemoryHint = null;
		stop();
	}
	if (pressureTimer) {
		clearIntervalTimer(pressureTimer);
		pressureTimer = null;
	}
}

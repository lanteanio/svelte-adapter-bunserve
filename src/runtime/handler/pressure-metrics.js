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
import { now, setIntervalTimer, clearIntervalTimer } from '../runtime.js';
import { createOsPressureSampler } from '../utils/os-pressure.js';
import { sweepRateLimits } from './rate-limit.js';
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

/**
 * Default pressure thresholds. Designed to be safe rather than tight: the
 * goal is "no false positives in the steady state of a healthy small app,"
 * not "perfectly tuned for sustained five-figure publish rates." Override
 * per-deployment via the `pressure` field on the WebSocket options.
 */
const DEFAULT_PRESSURE_THRESHOLDS = {
	// OFF BY DEFAULT ON THIS RUNTIME, and the one place this adapter's
	// defaults deliberately differ from the sibling's (which ships 0.85).
	//
	// heapUsed/heapTotal is a saturation measure only where the engine
	// over-allocates its heap. It does not here: a freshly booted, idle
	// server measured 0.90 to 0.94 (test/live/pressure-check.mjs pins that
	// it stays high), because this engine keeps heapTotal fitted close to
	// heapUsed. Against the family's 0.85 the signal therefore fires on an
	// idle process and never clears - `platform.pressure.active` would be
	// true for the life of every zero-config app, `onPressure` would announce
	// MEMORY once after boot and never recover, and a posture machine reading
	// it could never relax. A signal that is always on carries no
	// information and actively misleads, so it is off until the family
	// settles on a memory reading that means the same thing on both engines.
	//
	// Set `websocket: { pressure: { memoryHeapUsedRatio: 0.85 } }` to opt
	// back into the sibling's exact threshold.
	memoryHeapUsedRatio: false,
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
function samplePressure(thresholds) {
	const interval = thresholds.sampleIntervalMs / 1000;
	const publishRate = interval > 0 ? wsCounters.publishCountWindow / interval : 0;
	// Retain the raw window count before it is zeroed. The metrics hook exports
	// it as a monotonic counter rather than re-exporting `publishRate`: a
	// precomputed rate is only readable at the sampler's own cadence, while a
	// counter lets the query choose its window and survives a scrape interval
	// that does not match ours.
	wsCounters.lastPublishCount = wsCounters.publishCountWindow;
	wsCounters.publishCountWindow = 0;

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

	// Host memory read, deliberately not seam-routed (matching the sibling):
	// the figure is telemetry about the REAL process, and a simulated value
	// would only report the simulator's own heap.
	const mem = process.memoryUsage();
	const heapUsedRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
	const memoryMB = mem.rss / (1024 * 1024);
	// Both retained for the metrics hook. Resident memory is process-wide (worker
	// threads share one address space); the heap ratio is per-isolate, so each
	// worker thread reports its own.
	wsCounters.lastHeapUsedRatio = heapUsedRatio;
	wsCounters.lastResidentBytes = mem.rss;

	// Kernel signals for this window. Null per source when unavailable; the
	// sample fields stay absent then, so every downstream comparison and the
	// saturation fold skip them without a branch of their own.
	const os = osPressure.sample(thresholds.sampleIntervalMs);
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
		for (const cb of pressureListeners) {
			try {
				cb(pressureSnapshot);
			} catch (err) {
				console.error('[pressure] listener threw:', err);
			}
		}
	}

	if (overThreshold.length > 0) {
		if (publishRateListeners.size > 0) {
			for (const cb of publishRateListeners) {
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
 * Size the next send-gate window for an opted-in connection: per-connection
 * subscriber load narrows the window, so a worker carrying heavy fan-out
 * hands out smaller ones. Zero-config; never user exposed. Always floors to a
 * window large enough that a connection makes forward progress, and costs no
 * syscall - the reading it needs is bookkeeping this process already keeps.
 *
 * @returns {{ count: number, ttlMs: number }}
 */
export function grantSizeFor() {
	const conns = wsConnections.size || 1;
	const subRatio = wsCounters.totalSubscriptions / conns;
	// No heap term, for the same measured reason the memory THRESHOLD is off
	// by default above: leaseGrantSize narrows the window once the ratio
	// passes 0.7, a knee calibrated against an over-allocating heap. This
	// engine reports 0.90 to 0.94 on an IDLE server, so feeding it that
	// number collapses every window to roughly a sixteenth of the base
	// (~15 permits instead of 256) on a server under no load at all - the
	// opposite of the "healthy worker hands out the full window" contract.
	// Subscriber load is engine-independent and still narrows the window.
	const count = leaseGrantSize({ heapRatio: 0, subscriberRatio: subRatio });
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
export function startPressureSampling(opts) {
	const thresholds = resolvePressureThresholds(opts);
	if (pressureTimer) clearIntervalTimer(pressureTimer);
	pressureTimer = setIntervalTimer(() => samplePressure(thresholds), thresholds.sampleIntervalMs);
	if (pressureTimer && typeof pressureTimer.unref === 'function') pressureTimer.unref();
}

export function stopPressureSampling() {
	if (pressureTimer) {
		clearIntervalTimer(pressureTimer);
		pressureTimer = null;
	}
}

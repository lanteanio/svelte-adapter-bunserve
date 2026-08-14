// The standing leak gate: does serving for a while make the process grow?
//
// It boots the REAL built fixture server and drives it with real clients -
// there is no synthetic estimate here, because a leak is a property of the
// production path and a model of that path cannot have one. The shape is
// warmup, GC-forced baseline, a fixed-rate measured window sampling memory,
// cooldown, GC-forced final reading.
//
// TWO KINDS OF MEMORY QUESTION, and they need different instruments.
//
// RETENTION is asked with a difference: force the collector until it settles,
// at both ends, and compare. What survives a settled collection is held on
// purpose by something. That is the sensitive gate here - the figure is
// single-digit MB - and it is reproducible to a tenth of a percent. It counts
// heap PLUS external, because a typed array lives outside the JS heap and most
// of what a server retains is buffers.
//
// FOOTPRINT is asked with a slope, because a difference cannot tell a leak
// from an allocator that had not finished growing into its working set. A
// least-squares fit over many samples asks whether it is STILL climbing, and
// the r-squared floor is what stops noise answering: a runner whose RSS
// wanders has no linear fit, produces r-squared near zero, and cannot fail the
// build. Only growth that is both large and consistent does.
//
// FIVE INDEPENDENT GATES, because a leak surfaces in whichever one the
// workload exposes: retained heap, footprint slope, error rate, p95 latency
// creep, and connections still registered after every client has gone. A
// server quietly falling over often holds its memory flat while its tail
// latency doubles.
//
// Run with: npm run test:leak

import { assertPortFree, buildPath, serverEnv, waitForServer } from '../live/harness.mjs';
import { COOLDOWN_MS, MIN_SAMPLES, PORT, RESETTLE_MS, RPS, SAMPLE_MS, SELECTED, WARMUP_MS } from './plan.mjs';

const BASE = `http://127.0.0.1:${PORT}`;

/**
 * VERDICT THRESHOLDS, every one calibrated from real runs of this harness
 * rather than guessed. Raising one is a decision: it says this lane now
 * tolerates growth it used to fail. Record why in the same change.
 *
 * WHAT A HEALTHY RUN MEASURES on this fixture, so the headroom is legible and
 * a future reader can tell drift from a threshold that was always loose
 * (default window, three consecutive runs each):
 *
 *   retained growth   http +14.0%, +14.1%      ws +7.0%, +6.9%
 *   rss slope         http ~130 KB/s (r2 ~0.5) ws ~322 KB/s (r2 ~0.996)
 *   rss window growth http ~8%                 ws ~22%
 *   p95 creep         http negative            ws +/-5%
 *
 * And what the self-check's injected leak measures, for the other end of the
 * scale: retained +498%, slope ~3200 KB/s, window growth ~62%.
 *
 * THE RETENTION GATE IS THE SENSITIVE ONE, and the RSS gates are a backstop:
 *
 *   - Settled retention is reproducible to a TENTH OF A PERCENT across runs
 *     and is single-digit MB, so a retained megabyte is a large fraction of
 *     it. It is post-collection at both ends, so what it measures is retention
 *     rather than timing.
 *   - RSS under Bun's allocator climbs steeply and then decelerates toward a
 *     working-set plateau. The ws slope is ~312 KB/s over a 60s window with an
 *     almost perfect fit, which reads exactly like a leak - but the same
 *     workload over 240s measures 107 KB/s with r2 0.667, and the settled heap
 *     under both is flat. A curve that flattens is a plateau; a leak holds its
 *     slope. So an absolute RSS slope means little without knowing where in
 *     that curve the window sat, and these bounds are set to catch runaway
 *     rather than to be precise.
 */
const THRESHOLDS = {
	// A trend is only believed when it fits. Below this the samples are a cloud,
	// and a slope through a cloud is an artifact of where it starts and stops.
	minRSquared: 0.5,
	// Roughly 2.2x the healthy ws figure.
	maxWindowGrowthRatio: 0.5,
	// Roughly 3.3x the healthy ws slope. Runaway, not precision.
	maxSlopeBytesPerSec: 1024 * 1024,
	// Roughly 2.1x the healthy http figure. Both ends read after the collector
	// has SETTLED - see settledProbe, where a single forced GC is shown not to
	// be settled - and both count heap PLUS external, since a retained buffer
	// barely moves the heap.
	maxHeapGrowthRatio: 0.3,
	maxErrorRate: 0.005,
	maxP95CreepRatio: 0.5
};

/** @param {number[]} xs @param {number[]} ys */
function leastSquares(xs, ys) {
	const n = xs.length;
	const meanX = xs.reduce((a, b) => a + b, 0) / n;
	const meanY = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - meanX) * (ys[i] - meanY);
		sxx += (xs[i] - meanX) ** 2;
	}
	// A vertical or single-point fit has no slope to speak of, and reporting one
	// would be reporting a division by zero.
	if (sxx === 0) return { slope: 0, rSquared: 0 };
	const slope = sxy / sxx;
	const intercept = meanY - slope * meanX;
	let ssRes = 0;
	let ssTot = 0;
	for (let i = 0; i < n; i++) {
		ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
		ssTot += (ys[i] - meanY) ** 2;
	}
	// Perfectly flat samples fit perfectly, and a flat line is the ANSWER here,
	// not a degenerate case - but 0/0 would report it as the worst possible fit.
	if (ssTot === 0) return { slope, rSquared: 1 };
	return { slope, rSquared: 1 - ssRes / ssTot };
}

/** @param {number[]} values @param {number} q */
function quantile(values, q) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[idx];
}

/**
 * What the verdict calls "retained": heap PLUS external. A typed array lives
 * outside the JS heap, so a retained buffer - the shape of most real leaks in
 * a server, since that is what sockets and bodies are made of - moves
 * `external` and leaves `heapUsed` almost untouched. Measured: 64KB retained
 * per connection over 1000 connections moves heapUsed by 3.8% and this by 498%.
 *
 * @param {{ heapUsed: number, external?: number }} p
 */
const retained = (p) => p.heapUsed + (p.external || 0);

/**
 * Bounded like the workload units are, and for a sharper reason since the drive
 * loop AWAITS its outstanding sampler probes: an unbounded probe against a
 * server that accepted and never answered would hang the whole lane until the
 * runner's step timeout killed it, reporting nothing about why. The forced
 * collection gets the longer bound because it is a synchronous full GC and is
 * genuinely slower than a read.
 *
 * @param {boolean} [gc] force a full collection before reading
 */
async function probe(gc = false) {
	const res = await fetch(`${BASE}/_leak${gc ? '?gc=1' : ''}`, {
		signal: AbortSignal.timeout(gc ? 30_000 : 5_000)
	});
	if (!res.ok) throw new Error(`memory probe answered ${res.status}; is LEAK_PROBE armed on the server?`);
	return res.json();
}

/**
 * A heap reading that has stopped moving.
 *
 * ONE forced collection is not enough, and the difference is not small.
 * Measured on this fixture after 600 WebSocket connections had churned and the
 * clients had all closed: 5.76MB after the first forced GC, 3.71MB after the
 * second, then 3.68MB three times running. The first reading was 56% above the
 * settled one.
 *
 * Comparing single readings makes a HEALTHY run's growth swing between +7.5%
 * and +67.6% across three runs of the same workload, and no threshold can sit
 * inside that. Taking readings until two agree removes the swing, and the
 * settled value is the one that means "still retained".
 */
async function settledProbe(maxRounds = 8, tolerance = 0.02) {
	let last = await probe(true);
	for (let round = 2; round <= maxRounds; round++) {
		await Bun.sleep(200);
		const next = await probe(true);
		// Settles on the quantity the VERDICT compares, which is heap plus
		// external. Testing heapUsed alone leaves the larger and more volatile
		// half unchecked: measured on a quiescent server, five consecutive
		// settled-by-heapUsed readings spanned 32.7% of retained, driven
		// entirely by external moving while the heap held still.
		const settled = Math.abs(retained(next) - retained(last)) <= retained(last) * tolerance;
		last = next;
		if (settled) return { ...last, rounds: round };
	}
	return { ...last, rounds: maxRounds, unsettled: true };
}

const bytes = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/**
 * One unit of work. Returns how long it took, or null if it failed - a leak
 * harness that counts a failed request as a fast one reports a server that has
 * fallen over as a server that got quicker.
 *
 * @param {() => Promise<void>} fn
 */
async function timed(fn) {
	const t0 = performance.now();
	try {
		await fn();
		return performance.now() - t0;
	} catch {
		return null;
	}
}

/**
 * An SSR render plus a body read: the whole HTTP path, not just the router.
 *
 * Bounded like the ws unit is. A server that accepts and never answers would
 * otherwise leave the drive loop awaiting its in-flight set forever, and the
 * lane would hang rather than reporting the error rate that describes it.
 */
async function httpUnit() {
	const res = await fetch(`${BASE}/`, {
		headers: { connection: 'keep-alive' },
		signal: AbortSignal.timeout(5_000)
	});
	if (!res.ok) throw new Error(`GET / answered ${res.status}`);
	await res.text();
}

/**
 * Topics are drawn from a SMALL FIXED SET, and that is a correctness property
 * of this workload rather than a convenience.
 *
 * A unique topic per connection - the obvious way to write this - grows the
 * adapter's bounded per-topic maps by one entry per connection until they hit
 * their 10,000-topic cap. That is designed behaviour, and it is indistinguishable
 * from a leak over any window shorter than the time it takes to fill: measured
 * here, a random-topic version climbed steadily and would have been reported as
 * a defect in the server by a harness that had not noticed its own workload was
 * the cause. High-cardinality topic churn deserves its own scenario with the
 * cap as the assertion; it is not what a leak gate should be measuring.
 */
const TOPICS = Array.from({ length: 32 }, (_, i) => `leak:${i}`);
let topicCursor = 0;

/**
 * Connect, subscribe, publish, close. Per-connection state - subscriptions,
 * wire ids, cohort refs, seq counters - is exactly what a churn workload
 * strands if a release path is wrong, and none of it is reachable from HTTP.
 */
async function wsUnit() {
	await new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const done = (err) => {
			try { ws.close(); } catch {}
			err ? reject(err) : resolve();
		};
		const timer = setTimeout(() => done(new Error('ws unit timed out')), 5_000);
		ws.onerror = () => { clearTimeout(timer); done(new Error('ws errored')); };
		ws.onopen = () => {
			ws.send(JSON.stringify({ type: 'subscribe', topic: TOPICS[topicCursor++ % TOPICS.length], ref: 1 }));
		};
		ws.onmessage = (ev) => {
			const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
			if (msg && (msg.type === 'subscribed' || msg.type === 'subscribe-denied')) {
				clearTimeout(timer);
				done(null);
			}
		};
	});
}

/**
 * Drive `unit` at a fixed rate for `ms`, sampling memory on its own cadence.
 *
 * The pacing is deliberately open-loop: it dispatches on a schedule and does
 * not wait for the previous request. A closed loop would silently reduce the
 * offered load as the server slowed, which hides the very degradation the
 * latency gate exists to catch.
 *
 * @param {() => Promise<void>} unit
 * @param {number} ms
 * @param {{ sample: boolean }} opts
 */
async function drive(unit, ms, { sample }) {
	/** @type {number[]} */
	const latencies = [];
	let sent = 0;
	let failed = 0;
	/** @type {{ tMs: number, rss: number, heapUsed: number, connections: number }[]} */
	const samples = [];

	const started = performance.now();
	const inflight = new Set();
	const gap = 1000 / RPS;

	/** Every probe this sampler started, so none can outlive `drive()`. */
	const sampling = [];
	const sampler = sample
		? setInterval(() => {
			// Stamped at FIRE time rather than at push time. The probe is awaited
			// before its sample is recorded, so a push-time stamp folds the
			// probe's own round trip into the x axis - and that round trip is
			// longest exactly when the server is stressed, which is when the
			// slope is being relied on.
			const tMs = performance.now() - started;
			sampling.push(probe(false).then(
				(m) => samples.push({ tMs, rss: m.rss, heapUsed: m.heapUsed, connections: m.connections }),
				// A probe that fails is not a sample; the error gate owns liveness.
				() => {}
			));
		}, SAMPLE_MS)
		: null;

	let next = started;
	while (performance.now() - started < ms) {
		const now = performance.now();
		if (now >= next) {
			next += gap;
			sent++;
			const p = timed(unit).then((took) => {
				if (took === null) failed++;
				else latencies.push(took);
				inflight.delete(p);
			});
			inflight.add(p);
			// A server that stops answering must not let this loop queue an
			// unbounded backlog and OOM the harness instead of the subject.
			if (inflight.size > RPS * 4) await Promise.race(inflight);
		} else {
			await Bun.sleep(Math.min(gap, next - now));
		}
	}
	// `clearInterval` stops FUTURE firings; it cannot cancel a callback already
	// awaiting its probe. Awaiting those is what makes `samples` complete and
	// final when this returns, rather than an array the caller reads while a
	// push is still pending. It does NOT keep a straggler's reading out of the
	// fit - that reading is memory taken a little after its firing, which is
	// inherent to sampling through an async probe - and the fire-time stamp is
	// what keeps its x honest about when it was asked for.
	if (sampler) clearInterval(sampler);
	await Promise.all(sampling);
	await Promise.all(inflight);
	// Restored to firing order, which the pushes no longer preserve: a probe
	// slower than the cadence completes behind one fired after it. Least squares
	// does not care, but `samples[0]` and `samples.at(-1)` are read as the ends
	// of a trend, and under load - the case worth reading them in - they would
	// otherwise be the wrong pair.
	samples.sort((a, b) => a.tMs - b.tMs);
	return { latencies, sent, failed, samples };
}

/**
 * @param {string} name
 * @param {() => Promise<void>} unit
 * @param {{ expectFailure?: boolean, durationMs: number }} opts
 */
async function scenario(name, unit, opts) {
	// Supplied by the plan for every scenario, so there is no default to drift.
	const { durationMs } = opts;
	console.log(`\n== ${name}`);
	console.log(`   warmup ${WARMUP_MS / 1000}s, measure ${durationMs / 1000}s at ${RPS} rps, sample every ${SAMPLE_MS / 1000}s`);

	const warm = await drive(unit, WARMUP_MS, { sample: false });
	const baselineP95 = quantile(warm.latencies, 0.95);
	// No cooldown before this one, and the asymmetry with the final reading is
	// deliberate. The cooldown below exists for the CONNECTIONS gate - a count
	// only means "the close path leaked" once every client has had time to
	// finish closing - and only the final reading is compared on that. Settling
	// itself needs no fixed wait, because settledProbe is adaptive: it keeps
	// reading until two agree, so a warmup still shedding connections simply
	// costs it another round. Measured on the ws and self-check scenarios, the
	// baseline settles in three of its eight rounds.
	const baseline = await settledProbe();

	// Unsampled: see RESETTLE_MS. Sampling through the post-collection climb
	// measures the climb.
	await drive(unit, RESETTLE_MS, { sample: false });

	const run = await drive(unit, durationMs, { sample: true });

	await Bun.sleep(COOLDOWN_MS);
	const final = await settledProbe();

	const xs = run.samples.map((s) => s.tMs / 1000);
	const ys = run.samples.map((s) => s.rss);
	const { slope, rSquared } = leastSquares(xs, ys);
	const windowGrowth = slope * (durationMs / 1000);
	const growthRatio = baseline.rss > 0 ? windowGrowth / baseline.rss : 0;
	const errorRate = run.sent > 0 ? run.failed / run.sent : 0;
	const p95 = quantile(run.latencies, 0.95);
	const p95Creep = baselineP95 > 0 ? (p95 - baselineP95) / baselineP95 : 0;

	console.log(`   samples ${run.samples.length}, requests ${run.sent} (${run.failed} failed)`);
	const heapGrowth = retained(final) - retained(baseline);
	const heapRatio = retained(baseline) > 0 ? heapGrowth / retained(baseline) : 0;
	console.log(`   rss baseline ${bytes(baseline.rss)} -> final ${bytes(final.rss)} (both after forced GC)`);
	// The rounds are printed with whether each end actually CONVERGED, because
	// "settled over 8/8" for two loops that gave up reads exactly like success.
	const settleNote = (p) => `${p.rounds}${p.unsettled ? ' GAVE UP' : ''}`;
	console.log(`   retained (heap+external) baseline ${bytes(retained(baseline))} -> final ${bytes(retained(final))} (${(heapRatio * 100).toFixed(1)}%, over ${settleNote(baseline)}/${settleNote(final)} forced collections)`);
	console.log(`   slope ${(slope / 1024).toFixed(1)} KB/s, r2 ${rSquared.toFixed(3)}, projected over window ${bytes(windowGrowth)} (${(growthRatio * 100).toFixed(1)}% of baseline)`);
	console.log(`   ws connections during run ${run.samples[0]?.connections ?? -1} -> ${run.samples.at(-1)?.connections ?? -1}, after cooldown ${final.connections}`);
	console.log(`   p95 ${baselineP95.toFixed(1)}ms -> ${p95.toFixed(1)}ms (${(p95Creep * 100).toFixed(1)}%), errors ${(errorRate * 100).toFixed(2)}%`);

	// THREE KINDS, and the distinction is load-bearing rather than tidy.
	//
	// `memory` is a leak signal. `service` is a server misbehaving in a way
	// that is not a leak. `health` means this run did not MEASURE anything -
	// the instrument failed, so its silence proves nothing.
	//
	// All three fail an ordinary scenario. Only `memory` can satisfy the
	// self-check, and any `health` entry disqualifies it outright: a
	// self-check that collected one sample, or whose workload could not run,
	// would otherwise report "the gates are live" while detecting nothing, and
	// that is precisely the vacuous pass this scenario exists to rule out.
	/** @type {{ kind: 'memory' | 'service' | 'health', message: string }[]} */
	const failures = [];
	const fail = (kind, message) => failures.push({ kind, message });

	// The slope gates are ANDed with the fit on purpose: an unfitted slope is
	// not a trend, and failing on one is how a leak gate earns a reputation for
	// crying wolf and gets switched off.
	if (rSquared >= THRESHOLDS.minRSquared) {
		if (growthRatio > THRESHOLDS.maxWindowGrowthRatio) {
			fail('memory', `rss grew ${(growthRatio * 100).toFixed(1)}% of baseline over the window (limit ${(THRESHOLDS.maxWindowGrowthRatio * 100).toFixed(0)}%), fitted r2 ${rSquared.toFixed(3)}`);
		}
		if (slope > THRESHOLDS.maxSlopeBytesPerSec) {
			fail('memory', `rss climbing ${(slope / 1024).toFixed(1)} KB/s (limit ${THRESHOLDS.maxSlopeBytesPerSec / 1024} KB/s), fitted r2 ${rSquared.toFixed(3)}`);
		}
	}
	// The one comparison a first-and-last reading CAN make honestly, because
	// both ends are taken after the collector has settled: what is still held
	// is retained, not merely uncollected. RSS cannot be read this way - the
	// allocator keeps arenas it will never return - which is why the slope
	// above is the RSS signal and this is the retention one.
	if (heapRatio > THRESHOLDS.maxHeapGrowthRatio) {
		fail('memory', `retained grew ${(heapRatio * 100).toFixed(1)}% across the run (limit ${(THRESHOLDS.maxHeapGrowthRatio * 100).toFixed(0)}%)`);
	}
	if (errorRate > THRESHOLDS.maxErrorRate) {
		fail('service', `error rate ${(errorRate * 100).toFixed(2)}% (limit ${(THRESHOLDS.maxErrorRate * 100).toFixed(1)}%)`);
	}
	if (p95Creep > THRESHOLDS.maxP95CreepRatio) {
		fail('service', `p95 crept ${(p95Creep * 100).toFixed(1)}% above warmup (limit ${(THRESHOLDS.maxP95CreepRatio * 100).toFixed(0)}%)`);
	}
	// After the cooldown every client this scenario opened has closed, so a
	// connection still registered is one the close path did not release. This
	// is checked after the cooldown rather than during the run, where in-flight
	// connections are the workload rather than a leak.
	if (final.connections > 0) {
		fail('memory', `${final.connections} WebSocket connection(s) still registered after cooldown; every client had closed`);
	}
	// Too few samples cannot fail, but must not silently PASS either: a run
	// that collected three points proves nothing about a trend.
	if (run.samples.length < MIN_SAMPLES) {
		fail('health', `only ${run.samples.length} memory samples; a slope needs more than that to mean anything`);
	}
	// A settle loop that exhausted its rounds returned whichever reading it
	// happened to stop on, so the retention comparison - the sensitive gate -
	// was made against a number that does not mean "still retained". The same
	// class as too few samples: the instrument failed, so its silence proves
	// nothing, and believing it either masks a real leak inside the noise band
	// or invents one out of it.
	if (baseline.unsettled || final.unsettled) {
		const ends = [
			baseline.unsettled && `the baseline gave up after ${baseline.rounds} forced collections`,
			final.unsettled && `the final reading gave up after ${final.rounds} forced collections`
		].filter(Boolean).join(', and ');
		fail('health', `retention never settled: ${ends}; the retained comparison is noise`);
	}
	// A warmup that could not run leaves baselineP95 at zero, which silently
	// disables the p95 gate - so the run reports a clean tail latency it never
	// measured.
	//
	// The error side is held to the SAME rate as the measured window rather than
	// to zero. The warmup dispatches RPS * WARMUP_MS / 1000 units - 250 at the
	// defaults - so demanding that none of them fail makes the phase this file
	// exists to DISCARD the strictest gate in it: one transient socket in 250
	// would fail a lane whose measured window tolerates fifteen in three
	// thousand. That is the shape of gate people switch off.
	//
	// It is still the tighter of the two in practice, because the same rate over
	// 12x fewer units leaves a budget of exactly one failure before it trips.
	const warmErrorRate = warm.sent > 0 ? warm.failed / warm.sent : 1;
	if (baselineP95 <= 0 || warmErrorRate > THRESHOLDS.maxErrorRate) {
		fail('health', `warmup did not produce a clean baseline (${warm.failed} of ${warm.sent} failed, p95 ${baselineP95.toFixed(1)}ms)`);
	}

	const memory = failures.filter((f) => f.kind === 'memory');
	const health = failures.filter((f) => f.kind === 'health');
	// What a kind MEANS depends on the scenario, so the label does too. Under
	// expectFailure a memory gate is the result being looked for and a service
	// failure decides nothing at all - printing FAIL for that one puts the word
	// above a lane that then goes green, which is how grepping a CI log for
	// FAIL starts lying. A health failure still decides, so it keeps the word.
	for (const f of failures) {
		const label = opts.expectFailure
			? (f.kind === 'memory' ? 'detected' : f.kind === 'health' ? 'FAIL' : 'noted')
			: 'FAIL';
		console.log(`   ${label} ${f.message}`);
	}

	// A scenario can be here to prove the gates FIRE. Its pass condition is the
	// inverse, and the distinction is what keeps this lane from being vacuous:
	// gates never observed to fail are indistinguishable from gates that cannot.
	if (opts.expectFailure) {
		if (health.length) {
			// Said WITHOUT denying the gates that did fire: claiming nothing was
			// detected when three memory gates just printed `detected` sends the
			// reader hunting a phantom. What is wrong is the run, not the gates.
			const fired = memory.length
				? `; ${memory.length} memory gate(s) did fire, but a run that measured nothing cannot vouch for them`
				: '';
			console.log(`   FAIL the self-check did not measure what it claims to${fired}`);
			return false;
		}
		if (!memory.length) {
			console.log('   FAIL the injected leak was not caught by a MEMORY gate; this lane cannot detect a leak');
			return false;
		}
		console.log(`   ok (${memory.length} memory gate(s) caught the injected leak, so they are live)`);
		return true;
	}
	if (!failures.length) console.log('   ok');
	return failures.length === 0;
}

/**
 * Run one scenario against a server of its OWN.
 *
 * Each scenario gets a fresh process rather than sharing one, for two reasons.
 * The measurable one: a second scenario inherits the first's warmed allocator,
 * so it starts from a working set it did not build and its baseline means
 * something different from the first's. The necessary one: the self-check has
 * to arm a leak in the SERVER's environment, which cannot be done to a process
 * that is already running.
 *
 * @param {string} label
 * @param {() => Promise<void>} unit
 * @param {{ env?: Record<string, string>, expectFailure?: boolean, durationMs: number }} opts
 */
async function withServer(label, unit, opts) {
	await assertPortFree(PORT);
	const proc = Bun.spawn([process.execPath, buildPath()], {
		env: serverEnv({ PORT: String(PORT), LEAK_PROBE: '1', ...(opts.env || {}) }),
		stdout: 'inherit',
		stderr: 'inherit'
	});
	try {
		await waitForServer(proc, PORT);
		// Arming is asserted rather than assumed: an unarmed probe 404s, every
		// sample is then silently dropped, and a run that collected nothing looks
		// like a run that found nothing.
		await settledProbe();
		return await scenario(label, unit, opts);
	} finally {
		try { proc.kill(); } catch {}
		await proc.exited;
		// The next scenario asserts the port is free, and a killed Bun server
		// does not always release it within the same tick.
		await Bun.sleep(300);
	}
}

// What each planned scenario DOES, attached by key. The plan owns which
// scenarios exist and how long each measures, because the runner reads it to
// bound the lane; this owns the workload. Splitting it that way is what stops
// the two files disagreeing about how many scenarios there are.
const workloads = {
	http: { label: 'http: SSR render at a fixed rate', unit: httpUnit },
	ws: { label: 'ws: connect / subscribe / close churn', unit: wsUnit },
	selfcheck: {
		label: 'SELF-CHECK: a deliberate leak must fail this lane',
		unit: wsUnit,
		opts: {
			// 64 KB retained per connection and never released. At this rate the
			// gates see it within seconds, which is the point: the check has to be
			// quick enough that nobody is tempted to skip it.
			//
			// Its window is nonetheless well clear of the eight-sample floor - 30s
			// at the 2s cadence is fourteen, see samplesFor - because a self-check
			// that trips the floor is REFUSED rather than believed, so one sitting
			// near it would fail intermittently and teach people to ignore this
			// lane.
			env: { LEAK_INJECT: String(64 * 1024) },
			expectFailure: true
		}
	}
};

// Which scenarios run - and whether LEAK_SCENARIO named a real one - is the
// plan's decision, not a second copy of the same filter here. One scenario at a
// time is how a suspicious slope gets investigated: re-running the whole lane
// to look at one workload wastes minutes.
const results = [];
for (const { key, durationMs } of SELECTED) {
	const work = workloads[key];
	// A planned scenario with nothing attached is refused, not skipped. The
	// runner has already budgeted time for it, and quietly running one fewer
	// scenario than the plan describes is how a lane measures less than it says.
	if (!work) throw new Error(`the plan lists a "${key}" scenario but no workload is attached to it`);
	results.push(await withServer(work.label, work.unit, { ...work.opts, durationMs }));
}
const ok = results.every(Boolean);

// Named for the GATE rather than the lane, because run.mjs prints the lane's
// verdict too and two identical lines read as the thing having run twice.
console.log(ok ? '\nleak-check passed' : '\nleak-check FAILED');
process.exit(ok ? 0 : 1);

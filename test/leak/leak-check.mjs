// The standing leak gate: does serving for a while make the process grow?
//
// It boots the REAL built fixture server and drives it with real clients -
// there is no synthetic estimate here, because a leak is a property of the
// production path and a model of that path cannot have one. The shape is the
// svelte-adapter-uws lane's, phase for phase: warmup, a forced-collection
// baseline, a worked-but-unsampled resettle, a settle loop that opens the
// window only once the reading has held still, the window itself sampled on a
// fixed cadence, and a cooled-down final reading. The verdict is `rules.mjs`,
// which follows that lane's growth, retention and connection gates; see the
// header there for what each measures and why.
//
// WHAT IT REFUSES TO DO, and why each rule is here:
//
//   A SLOPE THROUGH A CLOUD IS NOT A TREND. Least squares fits a line through
//   anything, including noise, and the line it finds through a flat cloud tilts
//   with wherever the window happens to start and stop. The verdict therefore
//   needs the fit to EXPLAIN the samples: r-squared at or above 0.5. Without
//   it, a lane that runs long enough eventually reports a leak on a healthy
//   server.
//
//   A FORCED COLLECTION MANUFACTURES THE SIGNATURE IT LOOKS FOR. Sampling right
//   after one catches the process climbing back to its working set: steep,
//   near-perfectly linear, r-squared close to 1 - a textbook leak, drawn by the
//   measurement. So the baseline is collected, then the workload keeps running
//   through a resettle window that is deliberately NOT sampled, and only then
//   does the settle loop begin.
//
//   A GATE THAT CANNOT FAIL IS NOT A GATE. The self-check scenario settles a
//   clean server, then arms a real leak for the window and requires the
//   GROWTH GATE ITSELF to have detected it - a verdict failing on error rate
//   or latency creep is a failing verdict, not a detected leak. A lane that has
//   quietly lost the ability to detect one then says so, instead of reporting
//   a pass.
//
// EXIT CODES. 0 clean; 1 a scenario's verdict failed (a leak, an error rate, a
// latency creep, a server that died during the run, or a self-check that did
// not detect its own planted leak); 2 the lane could not reach a verdict it
// trusts (the server never became ready, a window never settled, the warmup
// itself was unhealthy, a probe failed against a live server). The
// distinction matters in CI: 1 is the server's problem, 2 is the lane's.
//
// Run with: npm run test:leak

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPortFree, buildPath, serverEnv, waitForServer } from '../live/harness.mjs';
import {
	COOLDOWN_MS, GC_PROBE_TIMEOUT_MS, HTTP_CLIENTS, MINUTES, PORT, PROBE_TIMEOUT_MS, RESETTLE_MS, RPS, CHURN_RPS, WS_RPS, WS_CLIENTS,
	SAMPLE_MS, SELECTED, SETTLE_BAND_BYTES, SETTLE_BAND_RATIO, SETTLE_MAX_ROUNDS, SETTLE_ROUND_MS,
	SETTLE_STABLE_ROUNDS, SETTLED_PROBE_ROUNDS, WARMUP_MS, WINDOW_MS, OUT_DIR
} from './plan.mjs';
import { judge, MAX_ERROR_RATE, quantile, retainedBytes, selfCheckVerdict } from './rules.mjs';

import { churnConnection, topicWorkload } from './workloads.mjs';

const BASE = `http://127.0.0.1:${PORT}`;

/**
 * One probe read. Bounded like the workload units are, and for a sharper
 * reason: the phases AWAIT their probes, so an unbounded probe against a server
 * that accepted and never answered would hang the whole lane until the
 * runner's step timeout killed it, reporting nothing about why.
 *
 * @param {'mem' | 'gc'} op
 */
async function probe(op) {
	const res = await fetch(`${BASE}/__leak?op=${op}`, {
		signal: AbortSignal.timeout(op === 'gc' ? GC_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`leak probe "${op}" answered ${res.status} - is LEAK_PROBE armed in the child?`);
	const body = await res.json();
	// A collection that did not happen is not a settled reading, and a lane
	// that went on measuring would be comparing unforced numbers under the
	// name of forced ones. The probe reports rather than throws; the decision
	// is made here, and it is to refuse.
	if (op === 'gc' && body.collected !== true) {
		throw new Error(`the server could not force a collection (${body.reason || 'no reason given'}); nothing measured here would be settled`);
	}
	return body;
}

/**
 * A heap reading that has stopped moving, for the retention gate.
 *
 * ONE forced collection is not enough, and the difference is not small.
 * Measured on this fixture after 600 WebSocket connections had churned and the
 * clients had all closed: 5.76MB after the first forced GC, 3.71MB after the
 * second, then 3.68MB three times running. The first reading was 56% above the
 * settled one. Comparing single readings makes a HEALTHY run's growth swing
 * between +7.5% and +67.6% across three runs of the same workload, and no
 * threshold can sit inside that. Taking readings until two agree removes the
 * swing, and the settled value is the one that means "still retained".
 *
 * Settles on the quantity the VERDICT compares, heap plus external. Testing
 * heapUsed alone leaves the larger and more volatile half unchecked: on a
 * quiescent server, five consecutive settled-by-heapUsed readings spanned
 * 32.7% of retained, driven entirely by external moving while the heap held
 * still.
 */
async function settledProbe(maxRounds = SETTLED_PROBE_ROUNDS, tolerance = 0.02) {
	await probe('gc');
	let last = await probe('mem');
	for (let round = 2; round <= maxRounds; round++) {
		await Bun.sleep(200);
		await probe('gc');
		const next = await probe('mem');
		const settled = Math.abs(retainedBytes(next) - retainedBytes(last)) <= retainedBytes(last) * tolerance;
		last = next;
		if (settled) return { ...last, rounds: round, unsettled: false };
	}
	return { ...last, rounds: maxRounds, unsettled: true };
}

/**
 * One unit of work. Returns how long it took and whether it succeeded - a
 * leak harness that counts a failed request as a fast one reports a server
 * that has fallen over as a server that got quicker.
 *
 * @param {() => Promise<void>} fn
 */
async function timed(fn) {
	const t0 = performance.now();
	try {
		await fn();
		return { ms: performance.now() - t0, ok: true };
	} catch {
		return { ms: performance.now() - t0, ok: false };
	}
}

/**
 * A semaphore of HTTP_CLIENTS permits: at most that many requests are on the
 * wire at once, so Bun's keepalive pool holds that many sockets and no more.
 * Without it the pool follows concurrency, and a server that slowed would
 * grow sockets and buffers in step with the backlog - which reads as a leak
 * and is not one. A unit that waits for a permit pays the wait in its
 * latency, which is what a request queued on a capped agent pays too.
 */
let permits = HTTP_CLIENTS;
/** @type {(() => void)[]} */
const waiting = [];
async function withClient(fn) {
	if (permits === 0) await new Promise((resolve) => waiting.push(resolve));
	else permits--;
	try {
		return await fn();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else permits++;
	}
}

/**
 * A bounded GET with the body read: the whole HTTP path, not just the router,
 * over one of the held keepalive connections.
 *
 * @param {string} pathname
 */
function get(pathname) {
	return withClient(async () => {
		const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`GET ${pathname} answered ${res.status}`);
		await res.text();
	});
}

/** An SSR render plus a body read. */
const httpUnit = () => get('/');

/**
 * The planted leak: each call retains a filled 64 KB buffer inside the SERVER
 * and never releases it. If the verdict comes back clean on a window of these,
 * the lane has lost the ability to detect a leak and says so.
 */
const retainUnit = () => get('/__leak?op=retain&kb=64');

/**
 * Topics are drawn from a SMALL FIXED SET, and that is a correctness property
 * of this workload rather than a convenience.
 *
 * A unique topic per connection - the obvious way to write this - grows the
 * adapter's bounded per-topic maps by one entry per connection until they hit
 * their 10,000-topic cap. That is designed behaviour, and it is
 * indistinguishable from a leak over any window shorter than the time it takes
 * to fill: measured here, a random-topic version climbed steadily and would
 * have been reported as a defect in the server by a harness that had not
 * noticed its own workload was the cause.
 */
const TOPICS = Array.from({ length: 32 }, (_, i) => `leak:${i}`);
let topicCursor = 0;

const churnUnit = () => churnConnection(`ws://127.0.0.1:${PORT}/ws`, TOPICS[topicCursor++ % TOPICS.length]);

/**
 * Drive `unit` at a fixed rate for `ms`, recording every request's outcome.
 *
 * The pacing is deliberately open-loop against an ABSOLUTE schedule: it
 * dispatches on a timetable computed from the start and does not wait for the
 * previous request. A closed loop would silently reduce the offered load as
 * the server slowed, which hides the very degradation the latency gate exists
 * to catch; a schedule computed from the last dispatch would let the timer's
 * granularity accumulate into a lower rate than the one printed.
 *
 * @param {() => Promise<void>} unit
 * @param {number} ms
 */
async function drive(unit, ms, rate = RPS) {
	/** @type {number[]} */
	const latencies = [];
	let requests = 0;
	let errors = 0;
	const started = performance.now();
	const inflight = new Set();
	const gap = 1000 / rate;

	let next = started;
	while (performance.now() - started < ms) {
		const now = performance.now();
		if (now >= next) {
			next += gap;
			requests++;
			// Every outcome's duration counts toward the tail, the failed ones
			// included: a request that timed out is the slowest thing the window
			// saw, and a p95 that dropped it would describe a server quicker
			// than the one measured.
			const p = timed(unit).then((r) => {
				latencies.push(r.ms);
				if (!r.ok) errors++;
				inflight.delete(p);
			});
			inflight.add(p);
			// A server that stops answering must not let this loop queue an
			// unbounded backlog and OOM the harness instead of the subject. Only
			// past four seconds of backlog does this turn the loop closed; up to
			// there it is open, and the creep gate sees the server slow down.
			if (inflight.size > rate * 4) await Promise.race(inflight);
		} else {
			await Bun.sleep(Math.min(gap, next - now));
		}
	}
	await Promise.all(inflight);
	const elapsedMs = performance.now() - started;
	return {
		requests,
		errors,
		latencies,
		// Reported rather than assumed: a lane that prints the rate it ASKED for
		// describes a workload it may not have applied.
		achievedRatePerSecond: elapsedMs > 0 ? (requests * 1000) / elapsedMs : 0
	};
}

/**
 * Run one scenario against the server on PORT.
 *
 * @param {string} name
 * @param {{ warm: () => Promise<void>, window: () => Promise<void> }} work
 *   the unit driven through warmup and settle, and the one driven through
 *   the measured window. The same for an ordinary scenario; the self-check
 *   warms and settles CLEAN and plants its leak only once the window opens,
 *   because a server retaining three megabytes a second never settles, and a
 *   self-check that could not settle would be refused as unmeasured rather
 *   than counted as detected.
 * @param {Record<string, unknown>} partial
 *   filled in as the phases complete, so that a scenario which throws still
 *   leaves what it measured in the record.
 */
async function runScenario(name, work, partial) {
	const rate = work.rate ?? RPS;
	console.log(`\n[leak-lane] ${name}: warmup ${WARMUP_MS / 1000}s, collect, resettle ${RESETTLE_MS / 1000}s unsampled, ` +
		`settle until steady, then a ${MINUTES} minute window at ${rate}/s`);

	// WARMUP. Fills the working set, JITs the hot paths and gives the creep
	// gate a baseline taken under the same load as the window.
	const warm = await drive(work.warm, WARMUP_MS, rate);
	const warmErrorRate = warm.requests > 0 ? warm.errors / warm.requests : 1;
	const baselineP95 = quantile(warm.latencies, 0.95);
	Object.assign(partial, { warmRequests: warm.requests, warmErrors: warm.errors, baselineP95 });

	// BASELINE. Forced collections until two agree - the retention gate's
	// reference reading. No cooldown before it, and the asymmetry with the
	// final reading is deliberate: the cooldown exists for the connections
	// gate, and only the final reading is compared on that.
	const baseline = await settledProbe();

	// RESETTLE. Worked, unsampled; see the header and RESETTLE_MS.
	await drive(work.warm, RESETTLE_MS, rate);

	// SETTLE. Keep working and reading until the resident set has stopped
	// MOVING - in either direction - for SETTLE_STABLE_ROUNDS rounds in a row.
	// After a forced collection it does not drift down to a resting point; it
	// CLIMBS back to the working set, so a rule that waits only for the reading
	// to stop falling opens the window on the most leak-shaped stretch a
	// healthy process ever produces.
	let settled = false;
	let previous = null;
	let stableRounds = 0;
	/** Every settle reading, kept in the record: a false alarm is unarguable with them and guesswork without. */
	const settleReadings = [];
	partial.settleReadings = settleReadings;
	for (let round = 0; round < SETTLE_MAX_ROUNDS; round++) {
		await drive(work.warm, SETTLE_ROUND_MS, rate);
		const { rss } = await probe('mem');
		settleReadings.push(rss);
		if (previous !== null) {
			const band = Math.max(SETTLE_BAND_BYTES, previous * SETTLE_BAND_RATIO);
			stableRounds = Math.abs(rss - previous) <= band ? stableRounds + 1 : 0;
			if (stableRounds >= SETTLE_STABLE_ROUNDS) { settled = true; break; }
		}
		previous = rss;
	}

	// WINDOW. One reading per slice while the workload continues.
	/** @type {number[]} */
	const rss = [];
	Object.assign(partial, { settled, rss });
	/** @type {number[]} */
	const latencies = [];
	/** Per-slice achieved rate, so the record states the workload applied rather than the one requested. */
	const achieved = [];
	let requests = 0;
	let errors = 0;
	for (let elapsed = 0; elapsed < WINDOW_MS; elapsed += SAMPLE_MS) {
		const slice = await drive(work.window, SAMPLE_MS, rate);
		achieved.push(slice.achievedRatePerSecond);
		requests += slice.requests;
		errors += slice.errors;
		latencies.push(...slice.latencies);
		rss.push((await probe('mem')).rss);
	}

	// FINAL. After the cooldown every client has had time to finish closing,
	// which is what makes the connections count mean "still registered".
	work.close?.();
	await Bun.sleep(COOLDOWN_MS);
	const final = await settledProbe();

	const windowP95 = quantile(latencies, 0.95);
	const verdict = judge({
		rss, errors, requests, baselineP95, windowP95, settled,
		retained: {
			baseline: retainedBytes(baseline),
			final: retainedBytes(final),
			settled: !baseline.unsettled && !final.unsettled
		},
		connectionsAfter: final.connections
	});

	// The warmup is held to the SAME error rate as the window, not to zero.
	// A stricter gate on the baseline than on the measurement is how a lane
	// starts failing for reasons nobody acts on.
	if (warmErrorRate > MAX_ERROR_RATE) {
		verdict.health.push(`the warmup itself lost ${(warmErrorRate * 100).toFixed(2)}% of ${warm.requests} requests`);
	}

	return {
		scenario: name, port: PORT, ratePerSecond: rate, minutes: MINUTES,
		requests, errors, baselineP95, windowP95,
		rss, settled, settleReadings, warmRequests: warm.requests, warmErrors: warm.errors,
		achievedRatePerSecond: achieved.length > 0 ? achieved.reduce((a, b) => a + b, 0) / achieved.length : 0,
		settledRounds: { baseline: baseline.rounds, final: final.rounds },
		connectionsAfter: final.connections,
		...verdict
	};
}

/**
 * Run one scenario against a server of its OWN.
 *
 * Each scenario gets a fresh process rather than sharing one: a second
 * scenario would inherit the first's warmed allocator, so it would start from
 * a working set it did not build and its baseline would mean something
 * different from the first's. The probe route answers only while `LEAK_PROBE`
 * is set in the child, so it never reaches a build anyone deploys.
 *
 * @param {string} name
 * @param {{ warm: () => Promise<void>, window: () => Promise<void> }} work
 * @param {Record<string, unknown>} partial
 */
async function withServer(name, work, partial) {
	await assertPortFree(PORT);
	const proc = Bun.spawn([process.execPath, buildPath()], {
		env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), LEAK_PROBE: '1' }),
		stdout: 'inherit',
		stderr: 'inherit'
	});
	let running = false;
	try {
		await waitForServer(proc, PORT);
		// Arming is asserted rather than assumed: an unarmed probe 404s, and a
		// run that could not read anything must fail here, as a health
		// problem, rather than after minutes of warmup.
		await probe('mem');
		if (name === 'ws') {
			const topics = await topicWorkload(`ws://127.0.0.1:${PORT}/ws`, WS_CLIENTS);
			work = { warm: topics.unit, window: topics.unit, close: topics.close, rate: WS_RPS };
		}
		running = true;
		return await runScenario(name, work, partial);
	} catch (err) {
		// A server that is GONE mid-run is the most server-caused outcome this
		// lane can find - a leak that ran the process out of memory ends
		// exactly this way - and must not be filed under "the lane could not
		// measure". The child's exit is what tells the two apart: a probe that
		// failed against a live server is the lane's problem, and so is a
		// server that never came up at all, since nothing was measured.
		//
		// Asked of the exit promise rather than of `exitCode`, and for two
		// reasons: a process killed by a signal - the out-of-memory killer's
		// SIGKILL, JavaScriptCore's abort on heap exhaustion - has NO exit
		// code, only a signal, and the child is reaped on the event loop a
		// tick or two after the connection it closed refused this probe.
		const gone = running && (await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]));
		if (gone) {
			const how = proc.signalCode ? `by ${proc.signalCode}` : `with code ${proc.exitCode}`;
			throw new ServerDied(`the server exited ${how} during the run: ${err.message}`);
		}
		throw err;
	} finally {
		work.close?.();
		try { proc.kill(); } catch {}
		await proc.exited;
		// The next scenario asserts the port is free, and a killed Bun server
		// does not always release it within the same tick.
		await Bun.sleep(300);
	}
}

class ServerDied extends Error {}

// One record per process, so parallel runs on the same machine do not
// overwrite each other. Rewritten after EVERY scenario rather than once at
// the end, so a run the runner has to kill still leaves the scenarios that
// finished - the evidence is wanted most on exactly the run that did not.
const RECORD_PATH = join(OUT_DIR, `leak-lane-${process.pid}.json`);
function writeRecord(records) {
	try {
		mkdirSync(OUT_DIR, { recursive: true });
		writeFileSync(RECORD_PATH, JSON.stringify({ bun: Bun.version, platform: process.platform, records }, null, '\t'));
		return true;
	} catch (err) {
		console.error(`[leak-lane] could not write the record: ${err.message}`);
		return false;
	}
}

// What each planned scenario DOES, attached by key. The plan owns which
// scenarios exist; this owns the workload. Splitting it that way is what
// stops the two files disagreeing about how many scenarios there are.
const workloads = {
	http: { warm: httpUnit, window: httpUnit },
	ws: {},
	churn: { warm: churnUnit, window: churnUnit, rate: CHURN_RPS },
	selfcheck: { warm: httpUnit, window: retainUnit }
};

/** @type {any[]} */
const records = [];
let exit = 0;
for (const name of SELECTED) {
	const work = workloads[name];
	// A planned scenario with nothing attached is refused, not skipped. The
	// runner has already budgeted time for it, and quietly running one fewer
	// scenario than the plan describes is how a lane measures less than it says.
	if (!work) throw new Error(`the plan lists a "${name}" scenario but no workload is attached to it`);

	let record;
	/** @type {Record<string, unknown>} */
	const partial = {};
	try {
		record = await withServer(name, work, partial);
	} catch (err) {
		if (err instanceof ServerDied) {
			console.error(`[leak-lane] ${name}: FAIL - ${err.message}`);
			records.push({ scenario: name, ...partial, failures: [err.message], health: [], failing: true });
			exit = Math.max(exit, 1);
		} else {
			console.error(`[leak-lane] ${name}: HEALTH - ${err.message}`);
			records.push({ scenario: name, ...partial, health: [err.message], failing: false });
			exit = Math.max(exit, 2);
		}
		writeRecord(records);
		continue;
	}
	records.push(record);
	writeRecord(records);

	const mib = (b) => (b / 1048576).toFixed(0);
	console.log(`[leak-lane] ${name}: ${record.requests} requests at ${record.achievedRatePerSecond.toFixed(0)}/s ` +
		`(asked ${record.ratePerSecond}/s), ${record.errors} failed, ` +
		`p95 ${record.baselineP95.toFixed(1)}ms warmed -> ${record.windowP95.toFixed(1)}ms`);
	console.log(`[leak-lane] ${name}: rss MiB over the window: ${record.rss.map(mib).join(' ')}`);
	console.log(`[leak-lane] ${name}: fit r-squared ${record.growth.rSquared.toFixed(2)}, verdict ${record.growth.reason}`);
	console.log(`[leak-lane] ${name}: settle MiB before the window opened: ${record.settleReadings.map(mib).join(' ')}` +
		(record.settled ? '' : ' (NEVER STEADY)'));
	console.log(`[leak-lane] ${name}: retained (heap+external) ${(record.retained.baseline / 1048576).toFixed(1)} MiB -> ` +
		`${(record.retained.final / 1048576).toFixed(1)} MiB (${(record.retained.ratio * 100).toFixed(1)}%, settled over ` +
		`${record.settledRounds.baseline}/${record.settledRounds.final} forced collections), ` +
		`connections after cooldown ${record.connectionsAfter}`);

	if (name === 'selfcheck') {
		// Inverted on purpose - this scenario is leaking by construction - and
		// typed on purpose: only the growth gate's own detection counts.
		const check = selfCheckVerdict(record);
		if (check.pass) {
			console.log(`[leak-lane] selfcheck: PASS - ${check.reason}`);
		} else {
			console.error(`[leak-lane] selfcheck: FAIL - ${check.reason}`);
			exit = Math.max(exit, 1);
		}
	} else if (record.failing) {
		for (const line of record.failures) console.error(`[leak-lane] ${name}: FAIL - ${line}`);
		exit = Math.max(exit, 1);
	} else {
		console.log(`[leak-lane] ${name}: PASS`);
	}
	for (const line of record.health) {
		console.error(`[leak-lane] ${name}: HEALTH - ${line}`);
		exit = Math.max(exit, 2);
	}
}

if (writeRecord(records)) console.log(`\n[leak-lane] record written to ${RECORD_PATH}`);

// Named for the GATE rather than the lane, because run.mjs prints the lane's
// verdict too and two identical lines read as the thing having run twice.
console.log(exit === 0 ? '\nleak-check passed' : exit === 1 ? '\nleak-check FAILED' : '\nleak-check could not reach a verdict');
process.exit(exit);

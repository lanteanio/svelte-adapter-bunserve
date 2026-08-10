// Micro-bench for making the counter seq the DEFAULT on publish. Before the
// change a publish with no options stamped nothing and returned immediately;
// now it draws the per-topic counter, and the envelope carries `,"seq":N` more
// bytes.
//
// The hot-path rule wants that measured rather than argued about, and the
// honest comparison is not "the stamp against nothing" but "the stamp against
// the work a publish already does beside it" - the envelope build. Both shapes
// are timed against the real stampSeqValue and the real completeEnvelope, so
// the delta reads as a fraction of a publish.
//
// MEASURED IN BOTH SIZE REGIMES, because they are not the same machine. The
// counter map is bounded, and the operations it does when it is FULL are the
// ones a busy deployment actually pays: an app publishing to client-named
// topics lives at the cap permanently, since nothing but a process restart
// brings the map back down. A bench that only ever runs a nearly-empty map
// measures the state such a deployment leaves within its first minute.
//
// That regime is also where the old shape was worst. Keeping a Map in
// least-recently-used order costs a delete and a re-add per touch, and
// Map.delete is not flat in map size - which is why the eviction is
// second-chance now, with the recency flag in a Set beside the map.
//
// Run under Bun (the shipped runtime): bun bench/publish-seq-default-micro.mjs

import { buildEnvelopePrefix, completeEnvelope } from '../src/runtime/utils/envelope.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { MAX_SEQ_TOPICS, stampSeqValue, topicSeqs } = await import('../src/runtime/handler/ws-state.js');

const ITERS = 1_000_000;
const HOT = 32; // live-topic cardinality inside one sample window

const topics = Array.from({ length: HOT }, (_, i) => 'room:' + i);
const prefixes = topics.map((t) => buildEnvelopePrefix(t, 'update'));
const data = { id: 1, value: 'hello world benchmark payload' };

/**
 * @param {boolean} stamped - true for the current default (absent options draw
 *   the counter), false for the previous one (absent options stamped nothing)
 * @param {number} cold - how many OTHER topics sit in the map while the hot
 *   set is stamped
 */
function run(stamped, cold) {
	topicSeqs.clear();
	// The hot topics go in first so they are the oldest entries: the position
	// an eviction sweep reaches first, and the one a recency scheme has to
	// rescue. Filling the other way round would measure the easy case.
	for (const t of topics) stampSeqValue(undefined, t);
	for (let i = 0; i < cold; i++) stampSeqValue(undefined, 'cold:' + i);
	let bytes = 0;
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) {
		const k = i & (HOT - 1);
		const seq = stamped ? stampSeqValue(undefined, topics[k]) : null;
		const envelope = completeEnvelope(prefixes[k], data, seq, null);
		bytes += envelope.length;
	}
	const ns = Bun.nanoseconds() - t0;
	return { perOp: ns / ITERS, bytes };
}

/**
 * @param {string} label
 * @param {number} cold
 */
function report(label, cold) {
	// Warm both shapes, then measure interleaved to keep thermal/JIT drift fair.
	run(false, cold); run(true, cold);
	const a1 = run(false, cold), b1 = run(true, cold), a2 = run(false, cold), b2 = run(true, cold);
	const base = (a1.perOp + a2.perOp) / 2;
	const stamped = (b1.perOp + b2.perOp) / 2;
	const delta = stamped - base;
	const extraBytes = (b2.bytes - a2.bytes) / ITERS;
	console.log(`\n  ${label} (${topicSeqs.size} topics in the map)`);
	console.log(`    seq-less publish (before):  ${base.toFixed(1)} ns/publish`);
	console.log(`    counter seq (default now):  ${stamped.toFixed(1)} ns/publish`);
	console.log(`    stamp cost:                 ${delta.toFixed(1)} ns/publish (${((delta / base) * 100).toFixed(1)}% of the envelope build alone; the full publish also pays the native fan-out)`);
	console.log(`    envelope growth:            ${extraBytes.toFixed(1)} bytes/publish`);
}

report('small working set', 0);
report('map at its bound', MAX_SEQ_TOPICS - HOT);
console.log();

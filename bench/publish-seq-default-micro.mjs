// Micro-bench for making the counter seq the DEFAULT on publish. Before the
// change a publish with no options stamped nothing and returned immediately;
// now it draws the per-topic counter, which is a Map get, a delete, a set and
// a size check, and the envelope carries `,"seq":N` more bytes.
//
// The hot-path rule wants that measured rather than argued about, and the
// honest comparison is not "the stamp against nothing" but "the stamp against
// the work a publish already does beside it" - the envelope build. Both
// shapes are timed here against the real stampSeqValue and the real
// completeEnvelope, so the delta reads as a fraction of a publish.
//
// The counter path is exercised at realistic topic cardinality: the LRU
// re-insert costs more the more topics are live, and at one topic it would
// measure a best case nobody runs.
//
// Run under Bun (the shipped runtime): bun bench/publish-seq-default-micro.mjs

import { buildEnvelopePrefix, completeEnvelope } from '../src/runtime/utils/envelope.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { stampSeqValue, topicSeqs } = await import('../src/runtime/handler/ws-state.js');

const ITERS = 2_000_000;
const TOPICS = 32; // realistic live-topic cardinality inside one sample window

const topics = Array.from({ length: TOPICS }, (_, i) => 'room:' + i);
const prefixes = topics.map((t) => buildEnvelopePrefix(t, 'update'));
const data = { id: 1, value: 'hello world benchmark payload' };

/**
 * @param {boolean} stamped - true for the current default (absent options draw
 *   the counter), false for the previous one (absent options stamped nothing)
 */
function run(stamped) {
	topicSeqs.clear();
	let bytes = 0;
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) {
		const k = i & (TOPICS - 1);
		const seq = stamped ? stampSeqValue(undefined, topics[k]) : null;
		const envelope = completeEnvelope(prefixes[k], data, seq, null);
		bytes += envelope.length;
	}
	const ns = Bun.nanoseconds() - t0;
	return { perOp: ns / ITERS, bytes };
}

// Warm both shapes, then measure interleaved to keep thermal/JIT drift fair.
run(false); run(true);
const a1 = run(false), b1 = run(true), a2 = run(false), b2 = run(true);
const base = (a1.perOp + a2.perOp) / 2;
const stamped = (b1.perOp + b2.perOp) / 2;
const delta = stamped - base;
const extraBytes = (b2.bytes - a2.bytes) / ITERS;
console.log(`\n  seq-less publish (before):  ${base.toFixed(1)} ns/publish`);
console.log(`  counter seq (default now):  ${stamped.toFixed(1)} ns/publish`);
console.log(`  stamp cost:                 ${delta.toFixed(1)} ns/publish (${((delta / base) * 100).toFixed(1)}% of the envelope build alone; the full publish also pays the native fan-out)`);
console.log(`  envelope growth:            ${extraBytes.toFixed(1)} bytes/publish`);
console.log(`  counters live:              ${topicSeqs.size} topics\n`);

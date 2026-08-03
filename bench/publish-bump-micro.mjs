// Micro-bench for the per-publish pressure bookkeeping added to the publish
// lanes: `publishCountWindow++` plus one `bumpTopicPublish` (a Map get, two
// field adds, an insert on a new topic). The hot-path rule wants the added
// cost measured, not asserted: this times the exact bump shape against the
// envelope build it rides beside, so the delta reads as a fraction of the
// work a publish already does.
//
// Run under Bun (the shipped runtime): bun bench/publish-bump-micro.mjs

import { buildEnvelopePrefix, completeEnvelope } from '../src/runtime/utils/envelope.js';

const ITERS = 2_000_000;
const TOPICS = 32; // realistic live-topic cardinality inside one sample window

const topicPublishStats = new Map();
function bumpTopicPublish(topic, count, size) {
	let s = topicPublishStats.get(topic);
	if (s === undefined) {
		s = { m: 0, b: 0 };
		topicPublishStats.set(topic, s);
	}
	s.m += count;
	s.b += size;
}

const topics = Array.from({ length: TOPICS }, (_, i) => 'room:' + i);
const prefixes = topics.map((t) => buildEnvelopePrefix(t, 'update'));
const data = { id: 1, value: 'hello world benchmark payload' };
const counters = { publishCount: 0, publishCountWindow: 0 };

function run(withBumps) {
	counters.publishCount = 0;
	counters.publishCountWindow = 0;
	topicPublishStats.clear();
	let bytes = 0;
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) {
		const k = i & (TOPICS - 1);
		// The work a publish already does before the native fan-out: build
		// the envelope. The bump rides beside it.
		const envelope = completeEnvelope(prefixes[k], data, null, null);
		counters.publishCount++;
		if (withBumps) {
			counters.publishCountWindow++;
			bumpTopicPublish(topics[k], 1, envelope.length);
		}
		bytes += envelope.length;
	}
	const ns = Bun.nanoseconds() - t0;
	return { perOp: ns / ITERS, bytes };
}

// Warm both shapes, then measure interleaved to keep thermal/JIT drift fair.
run(false); run(true);
const a1 = run(false), b1 = run(true), a2 = run(false), b2 = run(true);
const base = (a1.perOp + a2.perOp) / 2;
const bumped = (b1.perOp + b2.perOp) / 2;
const delta = bumped - base;
console.log(`\n  envelope build alone:   ${base.toFixed(1)} ns/publish`);
console.log(`  with pressure bumps:    ${bumped.toFixed(1)} ns/publish`);
console.log(`  bump cost:              ${delta.toFixed(1)} ns/publish (${((delta / base) * 100).toFixed(1)}% of the envelope build alone; the full publish also pays the native fan-out)`);
console.log(`  window drained:         ${topicPublishStats.size} topics tracked\n`);

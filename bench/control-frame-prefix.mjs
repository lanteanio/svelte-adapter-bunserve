// Micro-benchmark for the inbound demux prefix test.
//
// Every text frame a client sends pays this, so a change here is a hot-path
// change and needs before/after numbers with an unchanged control in the same
// run. It exists because a claim of "~14ns vs ~11ns" was once written into a
// comment BEFORE measuring, and was simply wrong.
//
// What it answers: how much does whitespace-tolerant recognition cost over the
// bare index-3 comparison, and how much would it cost to also accept frames
// whose `type` is not the first key (JSON defines no key order)? The reordered
// variants are what the shipped code REFUSES to pay for; `type`-first is a
// documented protocol requirement instead.
//
// Run: bun bench/control-frame-prefix.mjs

import { looksLikeControlFrame } from '../src/runtime/utils/control-frame.js';

/** The version this replaced: a bare index-3 comparison. */
function bareIndex3(text) {
	return text.charCodeAt(3) === 0x79;
}

function skipWs(text, i) {
	const limit = i + 16;
	while (i < limit) {
		const c = text.charCodeAt(i);
		if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
			i++;
			continue;
		}
		break;
	}
	return i;
}

/** Reorder-tolerant, bounded backwards scan. */
function reorderIndexOf(text) {
	const i = skipWs(text, 0);
	if (text.charCodeAt(i) !== 0x7b) return false;
	if (text.charCodeAt(i + 3) === 0x79) return true;
	return text.lastIndexOf('"type"', i + 64) !== -1;
}

/** Reorder-tolerant, slice plus regex. */
function reorderRegex(text) {
	const i = skipWs(text, 0);
	if (text.charCodeAt(i) !== 0x7b) return false;
	if (text.charCodeAt(i + 3) === 0x79) return true;
	return /"type"\s*:/.test(text.slice(0, 96));
}

// Realistic inbound mix: overwhelmingly application data envelopes, which are
// the frames that pay the miss path.
const frames = [];
for (let i = 0; i < 1000; i++) {
	frames.push(JSON.stringify({ topic: `room:${i}`, event: 'cursor', data: { x: i, y: i * 2 } }));
}
for (let i = 0; i < 20; i++) {
	frames.push(JSON.stringify({ type: 'subscribe', topic: `room:${i}`, ref: i }));
}

const REORDERED = JSON.stringify({ ref: 1, type: 'subscribe', topic: 'a' });
const PRETTY = JSON.stringify({ type: 'subscribe', topic: 'a' }, null, 8);

const variants = {
	'bare index-3 (old)': bareIndex3,
	'shipped': looksLikeControlFrame,
	'reorder: lastIndexOf': reorderIndexOf,
	'reorder: slice+regex': reorderRegex
};

function run(fn, iterations) {
	let hits = 0;
	const t0 = Bun.nanoseconds();
	for (let n = 0; n < iterations; n++) {
		for (let i = 0; i < frames.length; i++) if (fn(frames[i])) hits++;
	}
	if (hits < 0) throw new Error('unreachable');
	return (Bun.nanoseconds() - t0) / (iterations * frames.length);
}

const ITER = 2000;
const REPS = 5;
for (const fn of Object.values(variants)) run(fn, 100); // warm

/** @type {Record<string, number>} */
const best = {};
for (let rep = 0; rep < REPS; rep++) {
	for (const [name, fn] of Object.entries(variants)) {
		const ns = run(fn, ITER);
		if (best[name] === undefined || ns < best[name]) best[name] = ns;
	}
}

const base = best['bare index-3 (old)'];
console.log(`frames/pass ${frames.length} (1000 data envelopes, 20 control)`);
console.log(`total frames ${(ITER * frames.length * REPS * 4).toLocaleString()}   min-of-${REPS}\n`);
for (const [name, ns] of Object.entries(best)) {
	const delta = name === 'bare index-3 (old)' ? '' : `${(((ns - base) / base) * 100).toFixed(0)}%`;
	const fn = variants[name];
	const caps = [
		fn(PRETTY) ? 'pretty' : '-',
		fn(REORDERED) ? 'reordered' : '-',
		fn('["type"]') ? 'ARRAY-FALSE-POSITIVE' : '-'
	].join(' ');
	console.log(`${name.padEnd(22)} ${ns.toFixed(2).padStart(6)} ns  ${delta.padStart(6)}   ${caps}`);
}
console.log(
	'\nThe shipped shape accepts pretty-printed frames and rejects the array\n' +
	'false-positive. Reordered keys are refused deliberately: the variants that\n' +
	'accept them cost several times the shipped shape on every inbound frame.'
);

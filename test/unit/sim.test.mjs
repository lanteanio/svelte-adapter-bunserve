import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The fast lane's stake in the DST harness: one unfaulted and one faulted
// seed, each self-reproducing, and the unfaulted fingerprint pinned to the
// committed corpus entry. The full 40-seed gate is scripts/sim-golden.js
// (its own CI job); this smoke keeps a broken sim from surviving `npm test`
// long enough to reach it.

const { runSim, replaySim } = await import('../../src/sim.js');

const corpus = JSON.parse(
	readFileSync(new URL('../dst-goldens/adapter-single.golden.json', import.meta.url), 'utf8')
);

function fingerprintOf(result) {
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

test('an unfaulted run is clean, reproduces itself, and matches its corpus entry', async () => {
	const r = await runSim({ seed: '1' });
	assert.equal(r.invariantViolations.length, 0, JSON.stringify(r.invariantViolations));
	assert.equal(r.schedulerUncaught.length, 0);
	assert.ok(r.metrics.framesDelivered > 0, 'frames actually flowed');
	const entry = corpus.entries.find((e) => e.seed === '1');
	assert.ok(entry, 'corpus carries seed 1');
	assert.equal(fingerprintOf(r), entry.fingerprint, 'the committed corpus pins this exact run');
	const replay = await replaySim(r);
	assert.equal(replay.reproduced, true, 'same seed, same outcome');
});

test('a faulted run reproduces itself bit-for-bit', async () => {
	const r = await runSim({
		seed: '2',
		faults: { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 }
	});
	assert.equal(r.schedulerUncaught.length, 0);
	const replay = await replaySim(r);
	assert.equal(replay.reproduced, true, 'the fault interleaving is a function of the seed');
});

test('the committed corpus declares the family swarm config', () => {
	// The fingerprints are only comparable to the sibling adapter's corpus
	// under the SAME knobs; pin them so a config edit cannot silently
	// decouple the two.
	assert.equal(corpus.swarm.faultMode, 'random');
	assert.equal(corpus.swarm.faultProbability, 0.25);
	assert.deepEqual(corpus.swarm.faultProfile, { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 });
	assert.equal(corpus.entries.length, 40);
});

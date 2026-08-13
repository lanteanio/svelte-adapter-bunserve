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

test('the committed corpus records which commit blessed it', () => {
	// A seed plus a commit is the whole bug report this corpus exists to make
	// possible, and the seeds alone are half of one. The bless used to read an
	// environment variable nothing exported, so every entry recorded null and
	// nothing noticed for as long as the corpus existed. Nothing reads this
	// field, which is exactly why it needs a gate rather than a convention.
	//
	// A `-dirty` suffix PASSES, and refusing it would be a trap: re-blessing in
	// the same change that moved the fingerprints is the ordinary way this file
	// moves, and at that moment the code that produced it is not any commit
	// yet. What is being pinned is that the provenance is recorded at all.
	// Either object format, since the shape is git's and not ours.
	// Case-insensitive because the value can arrive from GIT_COMMIT, which is
	// unvalidated: git only ever writes lowercase, and rejecting an uppercase
	// sha would be a trap rather than a check. Shape is all this can gate - a
	// wrong-but-well-formed sha needs a git call, which does not belong in a
	// unit test.
	assert.match(
		corpus.gitCommit ?? '',
		/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})(-dirty)?$/,
		`corpus provenance is ${JSON.stringify(corpus.gitCommit)}, which is not a commit ` +
			'sha with an optional -dirty suffix. Re-bless with ' +
			'`node scripts/sim-golden.js --update` inside a git checkout, or set GIT_COMMIT ' +
			'to the full sha being blessed (a tag, branch or short sha will not do)'
	);
});

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

test('runs are order-independent: a seed rerun after other seeds is unchanged', async () => {
	// replaySim reruns a seed IMMEDIATELY, so state that leaks between runs
	// in the same order would reproduce and slip past that gate. This pins
	// the stronger property: interleave other seeds, and the rerun still
	// fingerprints identically - which is what proves resetSimState resets
	// everything the fingerprint can see.
	const F = { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 };
	const first = fingerprintOf(await runSim({ seed: '2', faults: F }));
	await runSim({ seed: '11', faults: F });
	await runSim({ seed: '1' });
	const again = fingerprintOf(await runSim({ seed: '2', faults: F }));
	assert.equal(again, first, 'cross-seed module state leaked into the rerun');
});

test('the committed corpus declares the family swarm config', () => {
	// The fingerprints are only comparable to the sibling adapter's corpus
	// under the SAME knobs; pin them so a config edit cannot silently
	// decouple the two.
	assert.equal(corpus.swarm.faultMode, 'random');
	assert.equal(corpus.swarm.faultProbability, 0.25);
	assert.deepEqual(corpus.swarm.faultProfile, { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 });
	// The base run config must stay empty: verify() replays the corpus under
	// the corpus's own recorded swarm block, so an unnoticed base would let
	// the corpus verify against itself under a config nobody reviewed.
	assert.deepEqual(corpus.swarm.base, {});
	assert.equal(corpus.entries.length, 40);
});

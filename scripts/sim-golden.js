// DST golden-set regression gate. The seed swarm proves each interleaving is
// internally deterministic (a seed reproduces its own fingerprint); this gate
// pins those fingerprints to a COMMITTED baseline so a code change that
// deterministically alters sim behavior fails loudly against the corpus.
// Intentional changes are blessed by regenerating the corpus (`--update`);
// the committed diff is the reviewable record of exactly what moved.
//
// Single-process corpus only: the cluster corpus joins when the multi-process
// slice lands, per the recorded scope. The swarm knobs are the family's -
// same seed range, fault mode and fault profile as svelte-adapter-uws's
// adapter-single corpus - which is what makes the two adapters' fingerprints
// comparable at all. The committed entries REPRODUCE the uws corpus exactly
// (verified against the parity pin when this corpus was first blessed; the
// cross-adapter check re-runs locally via --against <path-to-uws-corpus>).
//
// Lives under scripts/, outside the determinism seam, so it may read the
// clock and environment. The pure comparison lives in src/sim.js.
//
// Usage:
//   node scripts/sim-golden.js                     verify HEAD against the committed corpus (exit 1 on drift)
//   node scripts/sim-golden.js --update            regenerate + bless the corpus (refuses a broken/nondeterministic swarm)
//   node scripts/sim-golden.js --against <corpus>  additionally require fingerprint equality with a sibling corpus file

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { runSimSwarm, buildSimGoldens, checkSimGoldens } from '../src/sim.js';

const FAULT_PROFILE = { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 };

const CONFIG = {
	name: 'adapter-single',
	file: 'test/dst-goldens/adapter-single.golden.json',
	swarm: { count: 40, startSeed: 1, faultMode: 'random', faultProbability: 0.25, faultProfile: FAULT_PROFILE, base: {} }
};

const update = process.argv.includes('--update');
const againstIdx = process.argv.indexOf('--against');
const againstPath = againstIdx !== -1 ? process.argv[againstIdx + 1] : null;
const gitCommit = process.env.GIT_COMMIT || null;

/**
 * The sibling-corpus equality check: every seed present in both corpora must
 * carry the SAME fingerprint. This is the cross-adapter positioning guard -
 * identical golden traces are what keep the tier line a PERF statement, never
 * a capability statement - runnable wherever a sibling corpus file is at hand
 * (the uws checkout is not present in this repo's CI, so this is a local
 * ritual like probe:uws, and the committed corpus diff is its record).
 */
function compareAgainst(corpus, siblingFile) {
	const sibling = JSON.parse(readFileSync(siblingFile, 'utf8'));
	const ours = new Map(corpus.entries.map((e) => [e.seed, e.fingerprint]));
	let same = 0;
	const diffs = [];
	for (const e of sibling.entries) {
		const mine = ours.get(e.seed);
		if (mine === undefined) continue;
		if (mine === e.fingerprint) same++;
		else diffs.push(`seed ${e.seed}: ours ${mine} vs sibling ${e.fingerprint}`);
	}
	console.log(`sim-golden --against: ${same}/${sibling.entries.length} sibling fingerprints identical`);
	for (const d of diffs.slice(0, 10)) console.error('  ' + d);
	return diffs.length === 0;
}

async function buildCorpus() {
	// checkRatio 1 re-runs EVERY seed through replaySim: a seed that does not
	// reproduce is a determinism regression and must not enter the corpus.
	const { summary, runs } = await runSimSwarm({ ...CONFIG.swarm, checkRatio: 1, gitCommit });
	if (!summary.ok) {
		console.error(
			`sim-golden --update: swarm is not clean ` +
			`(${summary.failed} failing seed(s), ${summary.determinismFailures} determinism regression(s)). Nothing written.`
		);
		return null;
	}
	return buildSimGoldens({ summary, runs }, {
		gitCommit,
		recordedAt: new Date().toISOString(),
		swarm: {
			faultMode: CONFIG.swarm.faultMode,
			faultProbability: CONFIG.swarm.faultProbability,
			faultProfile: CONFIG.swarm.faultProfile,
			base: CONFIG.swarm.base
		}
	});
}

async function verify() {
	let corpus;
	try {
		corpus = JSON.parse(readFileSync(CONFIG.file, 'utf8'));
	} catch (err) {
		console.error(`sim-golden: cannot read corpus ${CONFIG.file} (${err.message}). Run \`node scripts/sim-golden.js --update\`.`);
		return false;
	}
	const swarm = corpus.swarm || {};
	const { summary, runs } = await runSimSwarm({
		seeds: corpus.entries.map((e) => e.seed),
		faultMode: swarm.faultMode,
		faultProbability: swarm.faultProbability,
		faultProfile: swarm.faultProfile,
		base: swarm.base,
		gitCommit
	});
	const report = checkSimGoldens(corpus, { summary, runs });
	if (report.ok) {
		console.log(`sim-golden ${CONFIG.name}: OK - ${report.counts.matched}/${corpus.entries.length} fingerprints match.`);
		if (againstPath) return compareAgainst(corpus, againstPath);
		return true;
	}
	console.error(`sim-golden ${CONFIG.name}: DRIFT - driftWeight ${report.driftWeight} > ${report.maxDriftWeight} (${report.counts.changed} changed, ${report.counts.missing} missing).`);
	if (report.configMismatch) console.error(`  config mismatch: ${report.configMismatch}`);
	for (const d of report.drifts.slice(0, 10)) {
		if (d.kind === 'missing') console.error(`  seed ${d.seed}: MISSING from run`);
		else console.error(`  seed ${d.seed}: ${d.golden.fingerprint} -> ${d.actual.fingerprint} (violations ${d.golden.digest.violations}->${d.actual.digest.violations})`);
	}
	console.error('  If this change is intentional, re-bless with `node scripts/sim-golden.js --update` and commit the corpus diff.');
	return false;
}

if (update) {
	const corpus = await buildCorpus();
	if (corpus === null) process.exit(1);
	if (againstPath && !compareAgainst(corpus, againstPath)) {
		console.error('sim-golden --update: REFUSING to bless a corpus that diverges from the sibling. Nothing written.');
		process.exit(1);
	}
	mkdirSync(dirname(CONFIG.file), { recursive: true });
	writeFileSync(CONFIG.file, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
	console.log(`sim-golden --update: wrote ${corpus.entries.length} golden(s) to ${CONFIG.file}`);
} else {
	if (!(await verify())) process.exit(1);
	console.log('sim-golden: corpus matches HEAD.');
}

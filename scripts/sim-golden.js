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
//   node scripts/sim-golden.js --against=<corpus>  the same flag, either spelling

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { runSimSwarm, buildSimGoldens, checkSimGoldens } from '../src/sim.js';

// This file's own checkout. Both the corpus and the provenance probe resolve
// against it rather than against the invoking directory: run from anywhere
// else, a cwd-relative corpus path made `--update` WRITE A NEW FILE under that
// directory and exit 0, so a contributor was told 40 goldens were blessed
// while the real corpus went untouched.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const FAULT_PROFILE = { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 };

const CONFIG = {
	name: 'adapter-single',
	// Repo-relative: this spelling is what the git pathspec and every message
	// want. CORPUS_PATH is what the filesystem gets.
	file: 'test/dst-goldens/adapter-single.golden.json',
	swarm: { count: 40, startSeed: 1, faultMode: 'random', faultProbability: 0.25, faultProfile: FAULT_PROFILE, base: {} }
};

const CORPUS_PATH = join(REPO_ROOT, CONFIG.file);

// What to CALL the corpus in output. The repo-relative spelling is the one a
// contributor recognises, but it names nothing from another directory - and
// "which file did that write" is the exact question a stray corpus used to
// leave open, so a run from elsewhere gets the full path.
const CORPUS_LABEL = process.cwd() === REPO_ROOT.replace(/[\\/]$/, '') ? CONFIG.file : CORPUS_PATH;

const update = process.argv.includes('--update');
// Both spellings, because `indexOf('--against')` cannot see `--against=path`
// and the miss is silent: the flag disappears, the gate runs, and it reports
// success without ever making the comparison that was asked for. A flag whose
// failure mode is a false pass has to accept the way people write it.
const againstIdx = process.argv.indexOf('--against');
const againstInline = process.argv.find((a) => a.startsWith('--against='));
const againstRequested = againstIdx !== -1 || againstInline !== undefined;
if (againstIdx !== -1 && againstInline !== undefined) {
	// The inline form is found by SPELLING rather than by position, so it wins
	// from either side and the other path is dropped in silence. Refusing is
	// the honest answer: the run would otherwise report a clean comparison
	// against a corpus the caller did not name.
	console.error('sim-golden: --against was given twice; pass one sibling corpus path.');
	process.exit(1);
}
const againstPath = againstInline !== undefined
	? againstInline.slice('--against='.length)
	: (againstIdx !== -1 ? process.argv[againstIdx + 1] ?? null : null);
if (againstRequested && (!againstPath || againstPath.startsWith('--'))) {
	// A value that looks like another flag is refused here rather than after a
	// full swarm, which is where reading it as a filename would fail. A real
	// file whose name starts with `--` is still reachable as `./--name.json`.
	console.error(
		'sim-golden: --against needs a path to a sibling corpus file' +
		`${againstPath ? ` (got ${JSON.stringify(againstPath)})` : ''}.`
	);
	process.exit(1);
}
/**
 * Which commit produced a corpus. A seed plus a commit IS the bug report this
 * corpus exists to make possible, and reading GIT_COMMIT alone recorded null
 * every time, because nothing exports it - so the corpus kept the seeds and
 * dropped the half a reader needs to check them out.
 *
 * A blessing whose TRACKED tree differs from that commit is marked `-dirty`,
 * the convention `git describe --dirty` uses. That is the ORDINARY case, not a
 * failure: re-blessing a corpus in the same change that moved its fingerprints
 * means the code that produced them is not any commit yet, and `-dirty` says
 * so - read it as "that commit's working tree", and the corpus diff sitting
 * beside the source diff is what supplies the rest.
 *
 * The probe is `git diff HEAD`, which is what "does the tree differ from that
 * commit" means, and it is why `git status` is the wrong question: untracked
 * files are not dirt, because they are not what checking that commit out would
 * have changed. A stray note file next to the checkout must not decide what a
 * corpus records. The corpus itself is excluded too - it is this script's own
 * OUTPUT, so a second `--update` would otherwise see its own fresh
 * `recordedAt` and call the tree dirty on that alone.
 *
 * The two probes are separate deliberately. Once HEAD resolves, the sha is
 * known and worth keeping whatever the diff probe then does; folding them into
 * one try discarded a good sha on an index lock, which loses the marker
 * exactly when the tree is busiest. An inconclusive probe (any exit other than
 * git's "there are differences") records `-dirty`, because the safe reading of
 * "could not confirm the tree matches" is that it might not.
 *
 * GIT_COMMIT overrides all of it - the hook for a job that already knows the
 * commit it checked out. Nothing in this repo sets it today.
 *
 * LIMIT: git is asked about this checkout's own directory, so a source tree
 * unpacked INSIDE an unrelated repository is answered by that repository.
 * No git, no repository, or no commit yet: null, exactly as before.
 */
function resolveGitCommit() {
	if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
	const opts = {
		encoding: /** @type {const} */ ('utf8'),
		stdio: /** @type {const} */ (['ignore', 'pipe', 'pipe']),
		cwd: REPO_ROOT,
		timeout: 10_000
	};
	let sha;
	try {
		sha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
	} catch {
		return null;
	}
	if (!sha) return null;
	try {
		execFileSync('git', ['diff', '--quiet', 'HEAD', '--', '.', `:(exclude)${CONFIG.file}`], opts);
		return sha;
	} catch (err) {
		// Exit 1 IS the answer: git says the tree differs. Any other status
		// means the question went unanswered - a corrupt index, a git too old
		// for pathspec exclusion, the timeout above - and the tree may well be
		// clean. `-dirty` is still the right record, since it claims less than
		// the truth rather than more, but silently marking a clean tree is how
		// someone spends an afternoon on a suffix that means nothing.
		if (err?.status !== 1) {
			const detail = String(err?.stderr || err?.message || '').trim().split('\n')[0];
			console.warn(
				`sim-golden: could not determine whether the tree matches ${sha.slice(0, 8)}` +
				`${detail ? ` (${detail})` : ''}; recording -dirty.`
			);
		}
		return `${sha}-dirty`;
	}
}

// Only a blessing records provenance. On the verify path this value reaches no
// output, no fingerprint and no comparison, so it is null there rather than
// resolved: two git subprocesses per CI run for a field nothing reads.
const gitCommit = update ? resolveGitCommit() : null;

/**
 * The sibling-corpus equality check: every seed present in both corpora must
 * carry the SAME fingerprint. This is the cross-adapter positioning guard -
 * identical golden traces are what keep the tier line a PERF statement, never
 * a capability statement - runnable wherever a sibling corpus file is at hand
 * (the uws checkout is not present in this repo's CI, so this is a local
 * ritual like probe:uws, and the committed corpus diff is its record).
 *
 * `siblingFile` is the one path here that stays relative to the INVOKING
 * directory, because a person typed it on the command line.
 */
function compareAgainst(corpus, siblingFile) {
	/** @type {any} */
	let sibling;
	try {
		sibling = JSON.parse(readFileSync(siblingFile, 'utf8'));
	} catch (err) {
		// A stack trace here reads as a crash in the gate rather than as what
		// it is: a path that was typed wrong, relative to the wrong directory,
		// or a sibling checkout that is not where it was expected.
		console.error(`sim-golden --against: cannot read sibling corpus ${siblingFile} (${err.message}).`);
		return false;
	}
	// Optional chaining because `null` is valid JSON: it parses without
	// throwing and then answers no property at all, which is the one shape
	// that would otherwise reach this line as a raw crash.
	if (!Array.isArray(sibling?.entries)) {
		console.error(`sim-golden --against: ${siblingFile} carries no entries array; is it a golden corpus?`);
		return false;
	}
	const ours = new Map(corpus.entries.map((e) => [e.seed, e.fingerprint]));
	let same = 0;
	const diffs = [];
	for (const e of sibling.entries) {
		const mine = ours.get(e.seed);
		if (mine === undefined) continue;
		if (mine === e.fingerprint) same++;
		else diffs.push(`seed ${e.seed}: ours ${mine} vs sibling ${e.fingerprint}`);
	}
	// Naming the file is the point: "40/40 identical" against the wrong corpus
	// reads exactly like the right one.
	console.log(`sim-golden --against ${siblingFile}: ${same}/${sibling.entries.length} sibling fingerprints identical`);
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
		corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
	} catch (err) {
		console.error(`sim-golden: cannot read corpus ${CORPUS_LABEL} (${err.message}). Run \`node scripts/sim-golden.js --update\`.`);
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
	mkdirSync(dirname(CORPUS_PATH), { recursive: true });
	writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
	console.log(`sim-golden --update: wrote ${corpus.entries.length} golden(s) to ${CORPUS_LABEL}`);
} else {
	if (!(await verify())) process.exit(1);
	console.log('sim-golden: corpus matches HEAD.');
}

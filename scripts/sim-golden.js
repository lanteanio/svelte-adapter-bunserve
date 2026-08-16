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
//   node scripts/sim-golden.js --corpus <name>     which committed corpus to run; defaults to adapter-single
//
// ONE CORPUS PER PROCESS. Each corpus names the server it runs against, and the
// handler graph builds that server once at import - so the corpora are separate
// invocations rather than a loop, and `sim:golden` runs them in turn.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
// Dependency-free and reads no global, so importing it before the server is
// chosen below is safe - unlike the simulator, which must not be loaded until
// after.
import { normalizeWsOptions } from '../src/runtime/utils/ws-options.js';

// This file's own checkout. Both the corpus and the provenance probe resolve
// against it rather than against the invoking directory: run from anywhere
// else, a cwd-relative corpus path made `--update` WRITE A NEW FILE under that
// directory and exit 0, so a contributor was told 40 goldens were blessed
// while the real corpus went untouched.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const FAULT_PROFILE = { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 };

/**
 * The committed corpora, keyed by the name `--corpus` selects.
 *
 * Each entry pairs a WORKLOAD with the SERVER it runs against, and the pairing
 * has to live here rather than in the corpus file because the server is decided
 * before the simulator is even loaded: the handler graph reads its options from
 * a global at import and builds the upgrade ceiling once, as a real deployment
 * does. That is why one process verifies one corpus - and why `sim:golden` is
 * two commands rather than one loop.
 *
 * `adapter-single` is the cross-adapter corpus: its workload is the shared
 * default scenario and its fingerprints REPRODUCE svelte-adapter-uws's, which is
 * what makes `--against` meaningful. Nothing adapter-specific may be added to
 * it; a workload only this adapter runs gets its own corpus, which is what
 * `adapter-admission` is.
 */
const CORPORA = {
	'adapter-single': {
		name: 'adapter-single',
		// Repo-relative: this spelling is what the git pathspec and every message
		// want. CORPUS_PATH is what the filesystem gets.
		file: 'test/dst-goldens/adapter-single.golden.json',
		scenario: 'default',
		// The sim's own default: an ungated server, byte-comparable with the
		// sibling adapter's corpus.
		wsOptions: null,
		swarm: { count: 40, startSeed: 1, faultMode: 'random', faultProbability: 0.25, faultProfile: FAULT_PROFILE, base: {} }
	},
	'adapter-admission': {
		name: 'adapter-admission',
		file: 'test/dst-goldens/adapter-admission.golden.json',
		scenario: 'admission',
		// A server with a ceiling, because the accounting this corpus exists to
		// pin does not exist without one - `upgradeAdmission` is null on a default
		// server, and every permit call is a no-op. The bounds are small on
		// purpose: against eight clients arriving in two waves they are crossed
		// often enough that refusals are part of the ordinary trajectory rather
		// than a rare seed, and BOTH of them answer some of those refusals - the
		// concurrent-upgrade ceiling during a wave, the live-connection ceiling
		// once the previous wave's survivors are holding permits.
		wsOptions: {
			allowedOrigins: 'any',
			path: '/ws',
			handler: 'src/ws-handler.js',
			allowUnauthenticatedSubscribe: true,
			upgradeAdmission: { maxConcurrent: 3, maxConnections: 5 }
		},
		swarm: {
			count: 40,
			startSeed: 1,
			faultMode: 'random',
			faultProbability: 0.25,
			faultProfile: FAULT_PROFILE,
			base: { clients: 8, topics: ['room', 'cursor'] }
		}
	}
};

const DEFAULT_CORPUS = 'adapter-single';

const update = process.argv.includes('--update');

/**
 * Read a `--flag value` / `--flag=value` argument, refusing every way of writing
 * it that would otherwise VANISH or be silently narrowed.
 *
 * Shared by `--against` and `--corpus` because they fail the same way and it is
 * the same failure that matters: a flag this parser cannot see does not error,
 * it disappears, and the gate then runs a comparison nobody asked for and
 * reports success. One parser means a guard added for one flag cannot go missing
 * on the other.
 *
 * Three refusals, each for a spelling that would otherwise pass:
 *
 * - both spellings are recognised, because `indexOf('--against')` cannot match
 *   `--against=path`;
 * - a repeated flag is COUNTED, not resolved. Whichever occurrence a rule picks,
 *   every other value is dropped in silence and the run reports a clean result
 *   against something the caller did not name. Which one would win is not even a
 *   position: the inline form is preferred wherever it sits, and only within one
 *   spelling does the first occurrence win, so `--against a --against=b` takes
 *   the LAST while `--against=b --against a` takes the FIRST. Refusing removes
 *   the question, and two of the same spelling are refused exactly as a mixed
 *   pair is;
 * - a missing value, or one shaped like another flag, is refused HERE rather
 *   than after a full swarm, which is where reading it as a value would fail.
 *
 * @param {string} flag the flag including its leading dashes
 * @param {string} needs how to finish "sim-golden: <flag> needs ..."
 * @param {string} single how to finish "... was given more than once; pass one ..."
 * @returns {{ requested: boolean, value: string | null }}
 */
function readFlag(flag, needs, single) {
	const inline = process.argv.find((a) => a.startsWith(flag + '='));
	const idx = process.argv.indexOf(flag);
	const requested = idx !== -1 || inline !== undefined;
	if (!requested) return { requested: false, value: null };
	const count = process.argv.filter((a) => a === flag || a.startsWith(flag + '=')).length;
	if (count > 1) {
		console.error(`sim-golden: ${flag} was given more than once; pass one ${single}.`);
		process.exit(1);
	}
	const value = inline !== undefined
		? inline.slice(flag.length + 1)
		: (process.argv[idx + 1] ?? null);
	if (!value || value.startsWith('--')) {
		console.error(
			`sim-golden: ${flag} needs ${needs}` +
			`${value ? ` (got ${JSON.stringify(value)})` : ''}.`
		);
		process.exit(1);
	}
	return { requested: true, value };
}

// A real file whose name starts with `--` is still reachable as `./--name.json`.
const { value: againstPath } =
	readFlag('--against', 'a path to a sibling corpus file', 'sibling corpus path');

// WHICH corpus. Selected before anything else happens, because the choice
// decides the SERVER the simulator is about to be loaded against, and that is
// fixed at import - see the WS_OPTIONS assignment below.
const { value: corpusName } = readFlag('--corpus', 'a corpus name', 'corpus name');
if (corpusName !== null && !Object.prototype.hasOwnProperty.call(CORPORA, corpusName)) {
	// Named rather than defaulted: falling back to the default corpus would run a
	// full gate and report success for a corpus the caller never asked about.
	console.error(
		`sim-golden: unknown corpus ${JSON.stringify(corpusName)}; ` +
		`known corpora are ${Object.keys(CORPORA).join(', ')}.`
	);
	process.exit(1);
}
const CONFIG = CORPORA[corpusName ?? DEFAULT_CORPUS];

const CORPUS_PATH = join(REPO_ROOT, CONFIG.file);

// What to CALL the corpus in output. The repo-relative spelling is the one a
// contributor recognises, but it names nothing from another directory - and
// "which file did that write" is the exact question a stray corpus used to
// leave open, so a run from elsewhere gets the full path.
const CORPUS_LABEL = process.cwd() === REPO_ROOT.replace(/[\\/]$/, '') ? CONFIG.file : CORPUS_PATH;

// THE SERVER, INSTALLED BEFORE THE SIMULATOR IS IMPORTED. The handler graph
// reads its options from this global at module load and builds the upgrade
// ceiling once, exactly as a deployed server does, so a corpus that needs a
// gated server cannot ask for one afterwards. Assigned rather than defaulted
// (`??=` is what src/sim.js uses for the ungated case) so the selected corpus
// decides, and `null` leaves the sim's own default in place.
//
// NORMALIZED, not handed over raw. A corpus entry names the handful of options
// its workload is about; a real server also carries the sixteen the build fills
// in - the subscription cap, the control-egress budget, the gate concurrency.
// Left undefined, those are limits the handler reads and finds absent, so the
// corpus would be pinning the behaviour of a server nobody can deploy. This is
// the same treatment src/sim.js gives its own default options.
if (CONFIG.wsOptions !== null) globalThis.WS_OPTIONS = normalizeWsOptions(CONFIG.wsOptions).options;

const { runSimSwarm, buildSimGoldens, checkSimGoldens, SIM_SCENARIOS } = await import('../src/sim.js');
const { upgradeAdmission } = await import('../src/runtime/handler/admission.js');

// The workload named by the corpus, resolved to the function that runs it. A
// scenario is not JSON, so the corpus records only its NAME and this is where
// the name becomes runnable again.
const WORKLOAD = SIM_SCENARIOS[CONFIG.scenario];
if (WORKLOAD === undefined) {
	console.error(`sim-golden: corpus ${CONFIG.name} names scenario '${CONFIG.scenario}', which the simulator does not define.`);
	process.exit(1);
}
// A corpus whose whole subject is the upgrade ceiling, verified against a server
// that has none, would run every seed and report ordinary drift - forty
// regressions in the code, for what is one wrong server. The controller is null
// on an ungated server, so this is the whole question.
if (CONFIG.wsOptions !== null && upgradeAdmission === null) {
	console.error(`sim-golden: corpus ${CONFIG.name} needs a gated server, but this process built none.`);
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
	const { summary, runs } = await runSimSwarm({
		...CONFIG.swarm,
		base: { ...CONFIG.swarm.base, ...WORKLOAD },
		scenarioName: CONFIG.scenario,
		checkRatio: 1,
		gitCommit
	});
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
			// The workload, by name. The base below carries the serializable knobs
			// only - a scenario is a function and JSON drops it without a word, so
			// a corpus that recorded the base alone would be re-verified against
			// whatever workload the runner happened to hold.
			scenario: CONFIG.scenario,
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
		// The corpus supplies the knobs it was blessed under; the registry supplies
		// the workload function the corpus named, which JSON could not carry. A
		// corpus recorded under a DIFFERENT name is caught by checkSimGoldens
		// rather than silently re-verified against this one.
		base: { ...swarm.base, ...WORKLOAD },
		scenarioName: CONFIG.scenario,
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

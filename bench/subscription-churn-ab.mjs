// Compare subscription churn and directed sends across commits: a subscribe and the
// unsubscribe that releases it (or the same pair as client frames), timed with
// every tree loaded side by side in one Bun process.
//
//   bun bench/subscription-churn-ab.mjs [--lane platform|wire|send|send-wire|send-wire-batch] [--processes N]
//       [--rounds N] <base-ref> <ref>...
//
// A ref is any commit-ish git knows, or `WORKTREE` for the working tree as
// it is now. The base is loaded twice, and the second copy is the A/A control:
// whatever separates it from the base is the noise floor of that run.
//
// Why not one process per tree, timed one after the other: on this workload a
// process lands in a JIT and code-layout state of its own that moves a tree by
// several percent for that process's whole life, so two identical trees in two
// processes routinely differ by more than the change being measured. Here each
// process times every tree in short interleaved chunks, so clock drift and GC
// land evenly on all of them, and the figure reported for a tree is the median
// across processes of its per-process paired median against the base. Each
// process loads the trees in a different order.
//
// Each tree is its own module graph. Copies that install the shared
// subscription-accounting sink displace one another's, which the runtime warns
// about; the warning is silenced here, and since every pair is balanced the
// installed sink stays at zero whichever it is.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** What a tree needs to run: the runtime, the hook stub, and the import map. */
const TREE_PATHS = ['src', 'test/helpers', 'package.json'];

const args = process.argv.slice(2);
if (args[0] === '--run') await runInProcess(args.slice(1));
else await drive(args);

async function drive(argv) {
	const opts = { lane: 'platform', processes: 12, rounds: 12 };
	const refs = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--lane') opts.lane = argv[++i];
		else if (a === '--processes') opts.processes = Number(argv[++i]);
		else if (a === '--rounds') opts.rounds = Number(argv[++i]);
		else refs.push(a);
	}
	if (refs.length < 2 || !['platform', 'wire', 'send', 'send-wire', 'send-wire-batch'].includes(opts.lane)) {
		console.error('usage: bun bench/subscription-churn-ab.mjs [--lane platform|wire|send|send-wire|send-wire-batch] [--processes N] [--rounds N] <base-ref> <ref>...');
		process.exit(2);
	}
	const repo = resolve(import.meta.dirname, '..');
	const work = mkdtempSync(join(tmpdir(), 'bunserve-churn-ab-'));
	try {
		/** @type {Array<{ label: string, dir: string }>} */
		const trees = [];
		const extract = (ref, label) => {
			const dir = join(work, String(trees.length));
			mkdirSync(dir, { recursive: true });
			if (ref === 'WORKTREE') {
				for (const p of TREE_PATHS) cpSync(join(repo, p), join(dir, p), { recursive: true });
			} else {
				writeTree(repo, ref, dir);
			}
			trees.push({ label, dir });
		};
		extract(refs[0], refs[0]);
		extract(refs[0], `${refs[0]} (A/A)`);
		for (const ref of refs.slice(1)) extract(ref, ref);

		/** @type {Map<string, number[]>} */
		const paired = new Map(trees.slice(1).map((t) => [t.label, []]));
		for (let p = 0; p < opts.processes; p++) {
			const order = trees.map((_, i) => trees[(i + p) % trees.length]);
			const out = spawnSync(
				process.execPath,
				['--conditions=bunserve-test', import.meta.filename, '--run', opts.lane, String(opts.rounds), trees[0].label,
					...order.map((t) => `${t.label}=${t.dir}`)],
				{ encoding: 'utf8', maxBuffer: 1 << 26 }
			);
			if (out.status !== 0) throw new Error(`process ${p + 1} failed:\n${out.stderr || out.stdout}`);
			const result = JSON.parse(out.stdout.trim().split('\n').pop() ?? '{}');
			for (const [label, value] of Object.entries(result)) paired.get(label)?.push(value);
			process.stderr.write(`process ${p + 1}/${opts.processes}\n`);
		}

		console.log(`Bun ${Bun.version}, ${opts.lane} lane, ${opts.processes} processes x ${opts.rounds} rounds`);
		console.log(`median across processes of each tree's paired median against ${refs[0]}:`);
		for (const [label, xs] of paired) {
			const s = [...xs].sort((a, b) => a - b);
			const spread = `${s[0].toFixed(1)}%..${s[s.length - 1].toFixed(1)}%`;
			console.log(`  ${label.padEnd(24)} ${fmt(median(xs))}   per process ${spread}`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** @param {string[]} argv */
async function runInProcess(argv) {
	const [lane, roundsArg, baseLabel, ...specs] = argv;
	const ROUNDS = Number(roundsArg);
	const CHUNK = 5000;
	const CHUNKS = 40;
	process.env.NODE_ENV = 'production';
	const g = /** @type {any} */ (globalThis);
	g.ENV_PREFIX = '';
	g.WS_OPTIONS = null;
	g.WS_PATH = '/ws';

	const warn = console.warn;
	console.warn = () => {};
	const trees = [];
	for (const spec of specs) {
		const at = spec.indexOf('=');
		const label = spec.slice(0, at);
		const root = pathToFileURL(spec.slice(at + 1) + '/');
		const load = (/** @type {string} */ rel) => import(new URL(rel, root).href);
		const { __setHooks } = await load('test/helpers/ws-handler-stub.mjs');
		__setHooks({ subscribe: () => null, ...(lane.startsWith('send') ? { close() {} } : {}) });
		const { websocketHandlers } = await load('src/runtime/handler/ws.js');
		const { platform } = await load('src/runtime/handler/platform.js');
		const { wsFacade } = await load('src/runtime/handler/ws-facade.js');
		const { CARRY_REQUEST_ID, WS_CAPS } = await load('src/runtime/handler/ws-state.js');
		const raw = {
			data: { [CARRY_REQUEST_ID]: 'bench' },
			readyState: 1,
			send: (/** @type {string} */ payload) => payload.length,
			subscribe: () => true,
			unsubscribe: () => true,
			isSubscribed: () => false,
			close() {
				if (raw.readyState !== 1) return;
				raw.readyState = 3;
				websocketHandlers.close(raw, 1000, '');
			},
			terminate() { raw.close(); },
			getBufferedAmount: () => 0,
			cork: (/** @type {() => unknown} */ fn) => fn()
		};
		websocketHandlers.open(raw);
		const ws = wsFacade(raw);
		// A refused subscribe installs nothing, and a loop of refusals times
		// something else entirely.
		const first = await platform.subscribe(ws, 'room:42');
		if (first !== null) throw new Error(`${label}: the subscribe was refused: ${first}`);
		platform.unsubscribe(ws, 'room:42');
		// One function per tree, so no call site in the timed loop is shared
		// between trees and none of them turns polymorphic on another's code.
		let directedRun;
		if (lane.startsWith('send')) {
			ws.getUserData()[WS_CAPS] = new Set(['bench:1']);
			const codec = {
				capability: 'bench:1', schemaVersion: 1,
				state: { onAttach: () => ({}) }, encode: () => new Uint8Array([1, 2])
			};
			const call = lane === 'send' ? "platform.send(ws, 'room:42', 'update', data)"
				: lane === 'send-wire' ? "platform.sendWire(ws, 'room:42', 'update', data, codec)"
				: "platform.sendWireBatch(ws, 'room:42', 'update', entries, codec)";
			directedRun = new Function('platform', 'ws', 'codec', 'data', 'entries', `return function send(n) {
				const t0 = Bun.nanoseconds();
				for (let i = 0; i < n; i++) ${call};
				return Bun.nanoseconds() - t0;
			}`)(platform, ws, codec, { x: 1 }, [{ data: { x: 1 } }, { data: { x: 2 } }]);
		}
		const run = directedRun ?? (lane === 'platform'
			? new Function('platform', 'ws', `return async function churn(n) {
				const t0 = Bun.nanoseconds();
				for (let i = 0; i < n; i++) {
					await platform.subscribe(ws, 'room:42');
					platform.unsubscribe(ws, 'room:42');
				}
				return Bun.nanoseconds() - t0;
			}`)(platform, ws)
			// Ref-less frames, so nothing is acked and the control budget is
			// never spent: an ack per frame would close the socket mid-run.
			: new Function('h', 'raw', 's', 'u', `return async function churn(n) {
				const t0 = Bun.nanoseconds();
				for (let i = 0; i < n; i++) {
					await h.message(raw, s);
					await h.message(raw, u);
				}
				return Bun.nanoseconds() - t0;
			}`)(websocketHandlers, raw, '{"type":"subscribe","topic":"room:7"}', '{"type":"unsubscribe","topic":"room:7"}'));
		trees.push({ label, raw, ws, run, res: /** @type {number[]} */ ([]) });
	}
	console.warn = warn;

	for (let w = 0; w < 5; w++) for (const t of trees) await t.run(100_000);
	for (let r = 0; r < ROUNDS; r++) {
		const sums = trees.map(() => 0);
		for (let c = 0; c < CHUNKS; c++) {
			for (let k = 0; k < trees.length; k++) {
				const i = (k + c + r) % trees.length;
				sums[i] += await trees[i].run(CHUNK);
			}
		}
		trees.forEach((t, i) => t.res.push(sums[i] / (CHUNK * CHUNKS)));
	}
	for (const t of trees) {
		if (t.raw.readyState !== 1 || t.ws._closed) throw new Error(`${t.label}: the connection closed under the bench`);
	}
	const base = trees.find((t) => t.label === baseLabel);
	if (!base) throw new Error(`no tree labelled ${baseLabel}`);
	/** @type {Record<string, number>} */
	const result = {};
	for (const t of trees) {
		if (t !== base) result[t.label] = median(t.res.map((v, i) => (v / base.res[i] - 1) * 100));
	}
	console.log(JSON.stringify(result));
}

/**
 * Write `ref`'s copy of TREE_PATHS under `dir`, read straight from the object
 * store: no worktree, no index and no archive tool, so nothing about the
 * repository changes and no platform's `tar` has to understand the path.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {string} dir
 */
function writeTree(repo, ref, dir) {
	const git = (/** @type {string[]} */ argv, /** @type {string | undefined} */ input) =>
		execFileSync('git', argv, { cwd: repo, input, maxBuffer: 1 << 30 });
	const listing = git(['ls-tree', '-r', '-z', ref, '--', ...TREE_PATHS]).toString('utf8');
	/** @type {Array<{ sha: string, path: string }>} */
	const blobs = [];
	for (const row of listing.split('\0')) {
		if (!row) continue;
		const tab = row.indexOf('\t');
		const [, type, sha] = row.slice(0, tab).split(' ');
		if (type === 'blob') blobs.push({ sha, path: row.slice(tab + 1) });
	}
	if (blobs.length === 0) throw new Error(`${ref} has none of ${TREE_PATHS.join(', ')}`);
	const out = git(['cat-file', '--batch'], blobs.map((b) => b.sha).join('\n') + '\n');
	let at = 0;
	for (const { path } of blobs) {
		const eol = out.indexOf(0x0a, at);
		const size = Number(out.subarray(at, eol).toString('latin1').split(' ')[2]);
		const body = out.subarray(eol + 1, eol + 1 + size);
		at = eol + 1 + size + 1;
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	}
}

/** @param {number[]} xs */
function median(xs) {
	return [...xs].sort((a, b) => a - b)[xs.length >> 1];
}

/** @param {number} v */
function fmt(v) {
	return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

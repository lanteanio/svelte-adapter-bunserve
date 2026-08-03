// Idle-connection memory A/B: spawn a WS server command, hold N idle
// sockets against it, and report the server process RSS before and after -
// per-socket resident cost is the number the tier table wants. Reusable for
// any server the family runs (the future ws-tier adapter gets it for free):
// the target is whatever command you pass, the measurement is by PID.
//
// Usage:
//   bun bench/idle-rss.mjs --cmd "bun bench/ws-fanout-bunserve.mjs" [--clients 1000] [--port 9002] [--path /]
//   bun bench/idle-rss.mjs --cmd "node ../svelte-adapter-uws/bench/24-ws-adapter-uws.mjs" --cwd ../svelte-adapter-uws
//
// RSS is read from the OS per PID (tasklist on Windows, /proc elsewhere),
// so the target needs no cooperation and no probe endpoint.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function arg(name, fallback) {
	const i = process.argv.indexOf('--' + name);
	return i !== -1 ? process.argv[i + 1] : fallback;
}

const CMD = arg('cmd', null);
const CWD = arg('cwd', process.cwd());
const CLIENTS = parseInt(arg('clients', '1000'));
const PORT = parseInt(arg('port', process.env.PORT || '9002'));
const PATH = arg('path', '/');
const SETTLE_MS = parseInt(arg('settle', '3000'));

if (!CMD) {
	console.error('usage: bench/idle-rss.mjs --cmd "<server command>" [--clients N] [--port P] [--path /ws]');
	process.exit(1);
}

/** Resident set size of a PID in bytes, by OS facilities only. */
function rssOf(pid) {
	if (process.platform === 'win32') {
		// CSV: "name","pid","session","sess#","mem usage" - mem like "123.456 K"
		// (locale-dependent thousands separator). A pid that no longer exists
		// yields a localized INFO sentence instead of CSV - fail loudly then,
		// because it means the target died and any number would be fiction.
		const line = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim();
		const cells = line.split('","');
		const mem = parseInt(cells[cells.length - 1].replace(/"|\s|[.,]/g, '').replace(/K$/i, ''), 10);
		if (cells.length < 5 || !Number.isFinite(mem)) {
			throw new Error(`pid ${pid} not found (server died?): ${line}`);
		}
		return mem * 1024;
	}
	const status = readFileSync(`/proc/${pid}/status`, 'utf8');
	const m = /VmRSS:\s+(\d+)\s*kB/.exec(status);
	if (!m) throw new Error(`no VmRSS for pid ${pid} (server died?)`);
	return parseInt(m[1], 10) * 1024;
}

/** The target port must be free BEFORE the spawn, or the held sockets would
 * connect to some other process and this bench would measure a corpse. */
async function assertPortFree(port) {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
	} catch {
		return;
	}
	console.error(`port ${port} is already in use - kill the stray server first`);
	process.exit(1);
}

const mb = (b) => (b / (1024 * 1024)).toFixed(1);

await assertPortFree(PORT);
const proc = Bun.spawn(CMD.split(' '), { cwd: CWD, stdout: 'inherit', stderr: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

try {
	const baseline = rssOf(proc.pid);
	console.log(`\n  Server pid ${proc.pid}, baseline RSS ${mb(baseline)} MB`);

	const sockets = [];
	const t0 = performance.now();
	// Connect in bounded batches so the accept queue is the bottleneck, not us.
	for (let i = 0; i < CLIENTS; i += 100) {
		const batch = [];
		for (let j = i; j < Math.min(i + 100, CLIENTS); j++) {
			batch.push(new Promise((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${PORT}${PATH}`);
				ws.onopen = () => resolve(ws);
				ws.onerror = () => reject(new Error('connect failed at socket ' + j));
			}));
		}
		sockets.push(...await Promise.all(batch));
	}
	console.log(`  Held ${sockets.length} idle sockets (connected in ${(performance.now() - t0).toFixed(0)}ms)`);

	// Let allocators settle before reading.
	await new Promise((r) => setTimeout(r, SETTLE_MS));
	const loaded = rssOf(proc.pid);
	const delta = loaded - baseline;
	console.log(`  Loaded RSS ${mb(loaded)} MB  (delta ${mb(delta)} MB, ${(delta / sockets.length / 1024).toFixed(1)} KB/socket)\n`);

	for (const ws of sockets) ws.close();
} finally {
	proc.kill();
}

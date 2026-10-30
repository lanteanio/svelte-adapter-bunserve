// The leak probe answers nothing unless it was armed, against a real server.
//
// The probe the leak lane reads the server through reports memory on demand,
// forces a full collection on demand, and retains buffers on request. None of
// that belongs in anything anyone deploys, and "it only exists in the test
// fixture" is a claim about where the file sits rather than a boundary the
// running server enforces. The environment variable is the boundary, so it is
// asserted here against a server that was not given it - which is every server
// except the one the lane spawns - and then, on a server that was, every
// operation the lane depends on is shown to answer in the shape it reads.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
import { churnConnection, topicWorkload } from '../leak/workloads.mjs';

const PORT = 8811;
const BUILD = buildPath();
const OPS = ['mem', 'gc', 'retain', 'release'];

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/**
 * Boot the built fixture with `extra` in its environment, run `fn` against it,
 * and stop it.
 *
 * @param {Record<string, string>} extra
 * @param {(base: string) => Promise<void>} fn
 */
async function withServer(extra, fn) {
	await assertPortFree(PORT);
	const proc = Bun.spawn([process.execPath, BUILD], {
		env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ...extra }),
		stdout: 'pipe',
		stderr: 'pipe'
	});
	try {
		await waitForServer(proc, PORT);
		await fn(`http://127.0.0.1:${PORT}`);
	} finally {
		try { proc.kill(); } catch {}
		await proc.exited;
		await Bun.sleep(300);
	}
}

// `serverEnv` strips LEAK_PROBE from the inherited shell, so this server is
// unarmed whatever the shell exported. That is the property under test, and
// the case would be meaningless if the harness itself had armed it.
check('the harness does not arm the probe on its own', serverEnv({}).LEAK_PROBE === undefined);

await withServer({}, async (base) => {
	for (const op of OPS) {
		const res = await fetch(`${base}/__leak?op=${op}`);
		await res.text();
		check(`unarmed: /__leak?op=${op} is not found`, res.status === 404, `answered ${res.status}`);
	}
	// The retain operation in particular: an unarmed server must not have
	// grown a buffer for the request it refused.
	const res = await fetch(`${base}/__leak?op=retain&kb=1024`);
	await res.text();
	check('unarmed: retain is refused, not honoured', res.status === 404, `answered ${res.status}`);
});

await withServer({ LEAK_PROBE: '1' }, async (base) => {
	const call = async (query) => {
		const res = await fetch(`${base}/__leak?${query}`);
		return { status: res.status, body: res.status === 200 || res.status === 400 ? await res.json() : await res.text() };
	};

	const gc = await call('op=gc');
	check('armed: gc collects', gc.status === 200 && gc.body.collected === true, JSON.stringify(gc.body));

	// Read AFTER the collection, so the external figure below is compared
	// against a settled baseline rather than against boot-time buffers the
	// first collection would have freed.
	const mem = await call('op=mem');
	check('armed: mem answers 200', mem.status === 200, `answered ${mem.status}`);
	for (const field of ['rss', 'heapUsed', 'heapTotal', 'external']) {
		check(`armed: mem reports a positive ${field}`, typeof mem.body[field] === 'number' && mem.body[field] > 0, JSON.stringify(mem.body[field]));
	}
	check('armed: mem counts zero retained buffers on a fresh server', mem.body.retained === 0, JSON.stringify(mem.body.retained));
	// The connections gate reads this. A server with no client has none, and
	// the probe must say 0 rather than the -1 that means it could not count.
	check('armed: mem reports zero live connections', mem.body.connections === 0, JSON.stringify(mem.body.connections));
	const wsURL = base.replace('http:', 'ws:') + '/ws';
	const connectionsClosed = async () => {
		for (let i = 0; i < 100; i++) {
			if ((await call('op=mem')).body.connections === 0) return true;
			await Bun.sleep(20);
		}
		return false;
	};
	const workload = await topicWorkload(wsURL);
	try {
		check('topic workload holds four live connections', (await call('op=mem')).body.connections === 4);
		await Promise.all(Array.from({ length: 32 }, () => workload.unit()));
		check('topic workload sends subscribe/broadcast/revoke cycles on held connections', true);
	} finally { workload.close(); }
	check('topic workload releases every held connection', await connectionsClosed());
	await churnConnection(wsURL, 'leak-churn-check');
	let denied = false;
	try { await churnConnection(wsURL, 'forbidden'); } catch { denied = true; }
	check('connection churn counts a denied subscription as failure', denied);
	check('successful and denied churn both release their connections', await connectionsClosed());

	const negative = await call('op=retain&kb=-4');
	const zero = await call('op=retain&kb=0');
	const junk = await call('op=retain&kb=lots');
	check('armed: a non-positive or unreadable size retains a buffer rather than throwing',
		negative.status === 200 && zero.status === 200 && junk.status === 200 && junk.body.retained === 3,
		`${JSON.stringify(negative.body)} ${JSON.stringify(zero.body)} ${JSON.stringify(junk.body)}`);
	check('armed: release clears them', (await call('op=release')).body.freed === 3);

	const one = await call('op=retain&kb=64');
	const two = await call('op=retain&kb=64');
	check('armed: retain counts up', one.body.retained === 1 && two.body.retained === 2, `${JSON.stringify(one.body)} then ${JSON.stringify(two.body)}`);
	// Collected before the reading, as the lane's retention gate always is:
	// this runtime brings the external figure up to date at collection time,
	// so a reading taken without one reports two fresh 64 KB buffers as a few
	// kilobytes. The buffers are held, so the collection cannot free them.
	await call('op=gc');
	const after = await call('op=mem');
	check('armed: mem sees the retained buffers', after.body.retained === 2, JSON.stringify(after.body.retained));
	// Filled, so they cost memory the process can see: two 64 KB buffers move
	// heap plus external - the quantity the lane's retention gate compares -
	// by at least that much. RSS is not asserted - the allocator may have had
	// the pages already.
	const retainedBytes = (m) => m.heapUsed + m.external;
	check('armed: retained buffers show in heap plus external once collected', retainedBytes(after.body) - retainedBytes(mem.body) >= 2 * 64 * 1024,
		`heap+external moved by ${retainedBytes(after.body) - retainedBytes(mem.body)}`);

	const released = await call('op=release');
	check('armed: release frees them all', released.body.freed === 2, JSON.stringify(released.body));
	check('armed: mem counts zero after release', (await call('op=mem')).body.retained === 0);

	const unknown = await call('op=nope');
	check('armed: an unknown op is a 400 that names the accepted ones', unknown.status === 400 && Array.isArray(unknown.body.accepts) && OPS.every((op) => unknown.body.accepts.includes(op)), JSON.stringify(unknown.body));
});

console.log(`\nleak-probe-check: ${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}

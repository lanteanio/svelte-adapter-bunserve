// A probe may be spelled with percent-escapes or with router syntax inside a
// segment. The adapter answers only that spelling, so every other spelling of
// the same path - a lowercase escape, an escaped letter, a SvelteKit data
// request - is refused rather than handed to the app's router, exactly as for
// a plain ASCII mount. Over raw sockets, since every HTTP client re-encodes
// the targets under test.
//
// Runs against the fixture's MOUNT_SPELLING build.

import { connect } from 'node:net';

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8881;
const BUILD = buildPath('build-mount-spelling');

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/**
 * The status of one request line sent exactly as written.
 * @param {string} method
 * @param {string} target
 * @returns {Promise<number>}
 */
function rawStatus(method, target) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = connect(PORT, '127.0.0.1');
		const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer to ${method} ${target}`)); }, 3000);
		const settle = () => {
			const text = Buffer.concat(chunks).toString('latin1');
			if (!text.includes('\r\n')) return false;
			clearTimeout(timer);
			socket.destroy();
			resolve(Number(text.split(' ')[1]));
			return true;
		};
		socket.on('data', (c) => { chunks.push(c); settle(); });
		socket.on('error', (err) => { clearTimeout(timer); reject(err); });
		socket.on('close', () => { if (!settle()) { clearTimeout(timer); reject(new Error(`closed without an answer to ${method} ${target}`)); } });
		socket.on('connect', () => {
			socket.write(Buffer.concat([
				Buffer.from(`${method} `), Buffer.from(target, 'utf8'),
				Buffer.from(` HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
			]));
		});
	});
}

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT, '/status:ready');

	const live = await fetch(`http://127.0.0.1:${PORT}/gesundheit-prüfung`);
	await live.arrayBuffer();
	check('the escaped probe answers the path a client writes', live.status === 200, `got ${live.status}`);
	check('and its spelling sent as written', await rawStatus('GET', '/gesundheit-pr%C3%BCfung') === 200);
	check('and the raw character, which Bun hands on escaped in uppercase', await rawStatus('GET', '/gesundheit-prüfung') === 200);
	const ready = await fetch(`http://127.0.0.1:${PORT}/status:ready`);
	await ready.arrayBuffer();
	check('a probe with ":" inside a segment answers', ready.status === 200, `got ${ready.status}`);

	for (const target of [
		'/gesundheit-pr%c3%bcfung',
		'/gesundheit-pr%C3%bcfung',
		'/%67esundheit-pr%C3%BCfung',
		'/gesundheit-pr%C3%BCfung/__data.json',
		'/gesundheit-pr%c3%bcfung/__route.js',
		'/status:ready/__data.json',
		'/status%3Aready'
	]) {
		const status = await rawStatus('GET', target);
		check(`GET ${target} is refused rather than handed to the app`, status === 400, `got ${status}`);
	}
	const lowercasePost = await rawStatus('POST', '/gesundheit-pr%c3%bcfung');
	check('whatever its method', lowercasePost === 400, `got ${lowercasePost}`);

	// The spelling itself, for a method the probe does not answer, is the app's,
	// as for any mount.
	const post = await rawStatus('POST', '/gesundheit-pr%C3%BCfung');
	check('a POST of the probe\'s own spelling reaches the app', post !== 400, `got ${post}`);
	// Bun resolves the dot segment before the adapter sees the target, so this
	// is the probe's own path here.
	const dotted = await rawStatus('GET', '/x/../gesundheit-pr%C3%BCfung');
	check('a dot-segment spelling arrives as the probe path', dotted === 200, `got ${dotted}`);
	const other = await rawStatus('GET', '/gesundheit-pr%C3%A9fung');
	check('another path decoding to another reading is not refused', other !== 400, `got ${other}`);
	// `%25` is a literal `%`: this is the path `/gesundheit-pr%C3%BCfung` spelled
	// out, not the mounted one, so the app answers it.
	const spelledOut = await rawStatus('GET', '/gesundheit-pr%25C3%25BCfung');
	check('a path that only decodes to the spelling of the mount reaches the app', spelledOut === 404, `got ${spelledOut}`);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	if (failed > 0) {
		console.log('\n--- stdout ---\n' + (await new Response(proc.stdout).text()).slice(-2000));
		console.log('\n--- stderr ---\n' + (await new Response(proc.stderr).text()).slice(-2000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);

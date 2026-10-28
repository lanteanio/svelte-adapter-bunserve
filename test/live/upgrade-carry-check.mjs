// What the upgrade carries to `open` arrives whatever the process has installed
// on Object.prototype. The server is booted with a preload that defines an
// accessor for the string key the request id used to ride: assigning that key
// went through the accessor's setter, so the connection opened with no request
// id. The id now rides a Symbol no other code can name.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8818;
const BUILD = buildPath();
const OLD_KEYS = ['__adapter_request_id'];

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

const dir = mkdtempSync(path.join(tmpdir(), 'upgrade-carry-'));
const preload = path.join(dir, 'accessors.mjs');
// The preload says it ran, so a preload that failed to load cannot pass the
// checks below for want of an accessor.
const PRELOAD_MARKER = 'upgrade-carry-preload-installed';
writeFileSync(
	preload,
	OLD_KEYS.map((key) =>
		`Object.defineProperty(Object.prototype, ${JSON.stringify(key)}, { configurable: true, set() {}, get() { return undefined; } });`
	).join('\n') + `\nconsole.log(${JSON.stringify(PRELOAD_MARKER)});\n`
);

/** Open one connection with an X-Request-ID and ask the fixture what it got. */
function askRequestId(requestId) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'x-request-id': requestId } });
		const timer = setTimeout(() => { settle(reject, new Error('no answer')); ws.close(); }, 5000);
		ws.onopen = () => ws.send(JSON.stringify({ type: 'fixture-request-id' }));
		ws.onmessage = (ev) => {
			const msg = JSON.parse(String(ev.data));
			if (msg.topic === '__fixture' && msg.event === 'request-id') {
				// Settled before the close: Bun's client can fire close
				// synchronously inside ws.close().
				settle(resolve, msg.data.requestId);
				ws.close();
			}
		};
		ws.onclose = (ev) => settle(reject, new Error(`closed ${ev.code} before answering`));
		ws.onerror = () => settle(reject, new Error('socket error'));
	});
}

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, '--preload', preload, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);
	const got = await askRequestId('carry-probe-1');
	check('the connection opens with the request id its upgrade carried', got === 'carry-probe-1', String(got));
	const second = await askRequestId('carry-probe-2');
	check('and so does the next one', second === 'carry-probe-2', String(second));
	check('the server is still running', proc.exitCode === null);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	await proc.exited;
	rmSync(dir, { recursive: true, force: true });
}
const stdout = await new Response(proc.stdout).text();
check('the preload installed its accessor before the server booted', stdout.includes(PRELOAD_MARKER), stdout.slice(0, 200));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log('failures:\n  - ' + failures.join('\n  - '));
	process.exit(1);
}

import assert from 'node:assert/strict';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8879;
await assertPortFree(PORT);
const child = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({
		MY_APP_HOST: '127.0.0.1', MY_APP_PORT: String(PORT),
		MY_APP_ADDRESS_HEADER: 'x-forwarded-for', MY_APP_TRUSTED_PROXIES: '192.0.2.1'
	}),
	stdout: 'pipe', stderr: 'pipe'
});
let out = '', err = '';
let socket;
const stdout = (async () => { for await (const chunk of child.stdout) out += Buffer.from(chunk).toString(); })();
const stderr = (async () => { for await (const chunk of child.stderr) err += Buffer.from(chunk).toString(); })();
try {
	await waitForServer(child, PORT);
	for (let i = 0; i < 2; i++) {
		const response = await fetch(`http://127.0.0.1:${PORT}/client-address`, {
			headers: { 'x-forwarded-for': '198.51.100.6' }, signal: AbortSignal.timeout(5000)
		});
		assert.equal(response.status, 200);
		await response.text();
	}
	socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('first upgrade did not open')), 5000);
		socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
		socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('first upgrade refused')); }, { once: true });
	});
	const refused = await fetch(`http://127.0.0.1:${PORT}/ws`, {
		headers: {
			upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
		}, signal: AbortSignal.timeout(5000)
	});
	assert.equal(refused.status, 429);
	await refused.text();
	const deadline = performance.now() + 3000;
	while (!err.includes('untrusted peer') || !err.includes('Restore real client addresses')) {
		if (child.exitCode !== null || performance.now() > deadline) throw new Error('missing untrusted-peer warning');
		await Bun.sleep(10);
	}
} catch (error) {
	console.error(out, err);
	throw error;
} finally {
	socket?.close();
	try { child.kill('SIGKILL'); } catch { /* already exited */ }
	await child.exited;
	await Promise.all([stdout, stderr]);
}
const warnings = err.split('\n').filter(line => line.includes('untrusted peer'));
assert.equal(warnings.length, 1);
assert.match(warnings[0], /not in MY_APP_TRUSTED_PROXIES/);
assert.match(warnings[0], /to MY_APP_TRUSTED_PROXIES\./);
assert.match(err, /MY_APP_ADDRESS_HEADER=x-forwarded-for/);
assert.match(err, /MY_APP_XFF_DEPTH/);
assert.match(err, /and MY_APP_TRUSTED_PROXIES/);
assert.doesNotMatch(err, /(?<!MY_APP_)(?:ADDRESS_HEADER|XFF_DEPTH|TRUSTED_PROXIES)/);
console.log('prefixed fixture: SSR and upgrade 429 warnings name the configured settings');

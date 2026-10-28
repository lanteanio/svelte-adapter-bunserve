// Invoke the registered signal handler through an isolated fixture endpoint.
// OS signal delivery remains covered by shutdown-check on supporting platforms.
import assert from 'node:assert/strict';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8866;
const base = `http://127.0.0.1:${PORT}`;

async function bounded(promise, label, ms = 8000) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
		})]);
	} finally { clearTimeout(timer); }
}

async function scenario(mode, timeout) {
	await assertPortFree(PORT);
	const proc = Bun.spawn([process.execPath, buildPath()], {
		env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), SHUTDOWN_TIMEOUT: String(timeout), SHUTDOWN_RECONNECT_WINDOW_MS: '0', FIXTURE_SHUTDOWN_DRIVER: mode }),
		stdout: 'pipe', stderr: 'pipe'
	});
	let out = '', err = '';
	const stdout = (async () => { for await (const chunk of proc.stdout) out += Buffer.from(chunk).toString(); })();
	const stderr = (async () => { for await (const chunk of proc.stderr) err += Buffer.from(chunk).toString(); })();
	let held;
	try {
		await waitForServer(proc, PORT);
		assert.equal((await fetch(`${base}/shutdown-driver`, { signal: AbortSignal.timeout(5000) })).status, 200);
		if (mode === 'request') {
			held = fetch(`${base}/shutdown-driver?hold=1`, { headers: { cookie: 'shutdown-test=1' } }).then(r => r.text()).catch(() => {});
			const readyBy = performance.now() + 5000;
			while (!out.includes('[shutdown-probe] request held')) {
				if (performance.now() >= readyBy || proc.exitCode !== null) throw new Error('held request did not start');
				await Bun.sleep(10);
			}
		}
		const started = performance.now();
		assert.equal((await fetch(`${base}/shutdown-driver`, { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 200);
		assert.equal(await bounded(proc.exited, 'shutdown'), 0);
		const elapsed = performance.now() - started;
		await bounded(Promise.all([stdout, stderr]), 'output');
		assert.match(out, /Received SIGTERM, shutting down gracefully/);
		const hook = JSON.parse(out.match(/\[shutdown-probe\] hook (\{[^\n]+\})/)[1]);
		const cleanup = JSON.parse(out.match(/\[shutdown-probe\] cleanup (\{[^\n]+\})/)[1]);
		assert.equal(hook.reason, 'SIGTERM');
		assert.equal(cleanup.reason, 'SIGTERM');
		assert.equal(cleanup.contextReason, 'SIGTERM');
		assert.equal(cleanup.sameSignal, true);
		assert.equal(cleanup.sameDeadline, true);
		assert.ok(out.indexOf('hook done') < out.indexOf('[shutdown-probe] cleanup '));
		if (mode === 'unlimited') {
			assert.equal(hook.signal, null);
			assert.equal(hook.deadline, null);
			assert.match(out, /cleanup done/);
			assert.ok(out.indexOf('cleanup done') < out.indexOf('Shutdown complete.'));
		} else {
			assert.equal(hook.signal, 'AbortSignal');
			assert.equal(typeof hook.deadline, 'number');
			assert.match(out, /Shutdown budget expired or cleanup failed/);
			assert.ok(elapsed >= 900 && elapsed < 2500, `shared deadline elapsed ${elapsed}ms`);
			if (mode === 'shared') {
				assert.equal(cleanup.aborted, false);
				assert.match(out, /cleanup budget aborted/);
				assert.doesNotMatch(out, /cleanup done/);
			} else {
				assert.equal(cleanup.aborted, true);
				assert.match(out, /request aborted .*"name":"AbortError".*The server shut down before the request finished/);
			}
		}
		console.log(`shutdown-handler: ${mode} passed`);
	} catch (error) {
		console.error(out, err);
		throw error;
	} finally {
		try { proc.kill('SIGKILL'); } catch { /* already exited */ }
		await bounded(proc.exited, 'child cleanup');
		if (held) await bounded(held, 'request cleanup');
	}
}

await scenario('unlimited', 0);
await scenario('shared', 1);
await scenario('request', 1);

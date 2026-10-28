import assert from 'node:assert/strict';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

if (process.platform === 'win32') {
	console.log('skip: OS shutdown signals require a POSIX host');
	process.exit(0);
}

const PORT = 8878;
const base = `http://127.0.0.1:${PORT}`;

async function until(check, child, label) {
	const deadline = performance.now() + 10000;
	while (!await check()) {
		if (child.exitCode !== null) throw new Error(`${label}: child exited ${child.exitCode}`);
		if (performance.now() >= deadline) throw new Error(`${label}: deadline exceeded`);
		await Bun.sleep(10);
	}
}

for (const duringInit of [false, true]) {
	for (const [first, second] of [['SIGTERM', 'SIGTERM'], ['SIGTERM', 'SIGINT'], ['SIGINT', 'SIGTERM'], ['SIGINT', 'SIGINT']]) {
		await assertPortFree(PORT);
		const child = Bun.spawn([process.execPath, buildPath()], {
			env: serverEnv({
				HOST: '127.0.0.1', PORT: String(PORT), SHUTDOWN_TIMEOUT: '0',
				FIXTURE_HANG_SHUTDOWN: '1', FIXTURE_HANG_INIT: duringInit ? '1' : '0',
				FIXTURE_SHUTDOWN_DRIVER: 'request'
			}),
			stdout: 'pipe', stderr: 'pipe'
		});
		let out = '', err = '';
		const stdout = (async () => { for await (const chunk of child.stdout) out += Buffer.from(chunk).toString(); })();
		const stderr = (async () => { for await (const chunk of child.stderr) err += Buffer.from(chunk).toString(); })();
		let held;
		let timeout;
		try {
			await waitForServer(child, PORT);
			if (duringInit) await until(() => out.includes('[shutdown-probe] init held'), child, 'init hook');
			else await until(async () => (await fetch(`${base}/readyz`)).status === 200, child, 'readiness');
			held = fetch(`${base}/shutdown-driver?hold=1`, { headers: { cookie: 'shutdown-test=1' }, signal: AbortSignal.timeout(10000) }).then(r => r.text()).catch(() => {});
			await until(() => out.includes('[shutdown-probe] request held'), child, 'held request');
			child.kill(first);
			if (duringInit) {
				await until(async () => (await (await fetch(`${base}/readyz`)).text()).includes('draining'), child, 'latched stop');
				assert.doesNotMatch(out, /\[fixture\] shutdown/);
			} else {
				await until(() => out.includes('[shutdown-probe] hook done'), child, 'shutdown hook');
			}
			assert.equal(child.exitCode, null);
			child.kill(second);
			const exit = await Promise.race([child.exited, new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error('second signal did not stop the child')), 3000);
			})]);
			clearTimeout(timeout);
			await Promise.all([stdout, stderr, held]);
			assert.equal(exit, 1, out + err);
			assert.match(out, /request aborted .*"name":"AbortError".*The server shut down before the request finished/);
			console.log(`shutdown signals: ${duringInit ? 'init' : 'drain'} ${first}/${second} passed`);
		} catch (error) {
			console.error(out, err);
			throw error;
		} finally {
			clearTimeout(timeout);
			try { child.kill('SIGKILL'); } catch { /* already exited */ }
			await child.exited;
			if (held) await held;
		}
	}
}

// Every child has an external deadline: a serializer that monopolizes its
// event loop must fail the suite rather than preventing its own timeout.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('../helpers/coalesced-live-child.mjs', import.meta.url));
for (const surface of ['production', 'testing']) for (const mode of ['cases', 'repeat-same', 'repeat-new']) {
	const proc = Bun.spawn([process.execPath, '--conditions=bunserve-test', child, mode, surface], {
		stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' }
	});
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 30_000);
	const [code, stdout, stderr] = await Promise.all([
		proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()
	]);
	clearTimeout(timer);
	assert.equal(timedOut, false, `${mode} monopolized the child event loop\n${stdout}\n${stderr}`);
	assert.equal(code, 0, `${mode} failed\n${stdout}\n${stderr}`);
	console.log(stdout.trim());
}

// Extra server entries, end to end: the fixture's Vite config adds three
// `__`-prefixed entries to the SvelteKit server build, the way the realtime
// layer adds its generated registry, and writes a fourth into the server
// output by hand; this boots the built server and asks what they recorded.
// The build has to find them in the server output, bundle each as its own
// entry, and import them at the top of the built index.js, in file-name order,
// by the file its Rollup pass wrote, and before the WebSocket handler module
// loads. vite.config.js says what each name is there to catch.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8824;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

// By code unit, which is not the order NTFS lists them in, nor the order the
// fixture's plugin adds them. `__probe#x` is the hand-written one.
const EXPECTED = ['__probe#x', '__probe-B', '__probe-a', "__probe-it's"];
// The file the build's Rollup pass writes for each: `#` is not kept in a file
// name, so that entry has to be imported by the name Rollup gave it.
const WRITTEN = ['__probe_x.js', '__probe-B.js', '__probe-a.js', "__probe-it's.js"];

// The generated index, before anything runs it: one import per entry, at the
// top, each specifier JSON-quoted.
const index = readFileSync(join(dirname(BUILD), 'index.js'), 'utf8').split('\n');
const imports = index.slice(0, WRITTEN.length);
check('the built index imports every extra entry first, in file-name order, by the file Rollup wrote',
	WRITTEN.every((file, i) => imports[i] === `import ${JSON.stringify(`./server/${file}`)};`),
	JSON.stringify(imports));

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);
	const res = await fetch(`http://127.0.0.1:${PORT}/extra-entries`);
	const { ran, dynamicEnvKeysNow } = await res.json();
	check('every extra entry ran at startup', Array.isArray(ran) && ran.length === EXPECTED.length,
		JSON.stringify(ran));
	check('in file-name order', Array.isArray(ran) && EXPECTED.every((name, i) => ran[i]?.name === name),
		JSON.stringify(ran));
	check('before the WebSocket handler module loaded',
		Array.isArray(ran) && ran.length > 0 && ran.every((r) => r.handlerLoaded === false),
		JSON.stringify(ran));
	// What the README tells a plugin author: an entry's top level, up to its
	// first await, runs before SvelteKit's server is initialized, so the dynamic
	// env is still empty there, though a request sees it populated.
	// The hand-written entry never went through Vite, so it has no env to read.
	const viteBuilt = Array.isArray(ran) ? ran.filter((r) => r.dynamicEnvKeys !== null) : [];
	check('before SvelteKit populated the dynamic env',
		viteBuilt.length === EXPECTED.length - 1 && viteBuilt.every((r) => r.dynamicEnvKeys === 0) && dynamicEnvKeysNow > 0,
		JSON.stringify({ ran, dynamicEnvKeysNow }));
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	try { proc.kill('SIGKILL'); } catch { /* already gone */ }
	if (failed > 0) {
		console.log('\n--- server stdout ---\n' + (await new Response(proc.stdout).text()).slice(-2000));
		console.log('\n--- server stderr ---\n' + (await new Response(proc.stderr).text()).slice(-2000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);

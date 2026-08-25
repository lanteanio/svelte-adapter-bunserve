// The boot banner, asserted against the BUILT server. Everything the banner
// says is read from files at runtime - the meta/ copies of package.json and
// protocol.schema.json, and the sibling resolution against the app's own
// node_modules - so only a real build can prove the line tells the truth:
// a unit test feeds versionInfo() synthetic inputs, and a banner wrong about
// the deployed bytes would still pass it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8813;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

// The version the banner MUST report: the adapter package.json, read here the
// same way the build's meta copy was made from it - never a literal, which
// would go stale on the next release with this check still green.
const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
);

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);
	// The banner prints before the listen line, so by the time the server
	// answers a request it is already in the captured stream.
	proc.kill();
	const stdout = await new Response(proc.stdout).text();
	const banner = stdout.split('\n').find((l) => l.startsWith('svelte-adapter-bunserve '));
	check('the boot log carries the banner line', banner !== undefined, stdout.slice(0, 300));
	if (banner) {
		check('the version is the deployed package.json, read at runtime',
			banner.startsWith(`svelte-adapter-bunserve ${pkg.version} (`), banner);
		check('the protocol revision is parsed from the schema the build carries',
			/\(protocol rev 1, /.test(banner), banner);
		// The fixture installs neither sibling, so an honest resolution against
		// the app's node_modules answers "not installed" for both - and a
		// bundled copy of either would answer a version here instead.
		check('an absent sibling reads as not installed, in the family wording',
			banner.includes('svelte-realtime not installed'), banner);
		check('both siblings resolve independently',
			banner.includes('svelte-adapter-uws-extensions not installed'), banner);
	}
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log('failures:\n  - ' + failures.join('\n  - '));
	process.exit(1);
}

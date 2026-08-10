// Dotfile exclusion, end to end against the real server.
//
// The unit lane proves the predicate and the index-time walk. What it cannot
// prove is the thing an operator actually cares about: that a stray .env-shaped
// file in static/ is NOT reachable over HTTP from the built server, and that
// .well-known/ discovery still is. Both builds of the SAME static/ tree run
// here - the default one, which must refuse, and the staticDotfiles: true one,
// which must serve - so the escape hatch is asserted as real rather than
// assumed from a build-time constant.
//
// Every refusal check also inspects the BODY for the marker string the fixture
// files carry. A 404 whose body happens to contain the secret would be a leak
// that a status-only assertion reports as a pass.
//
// This suite runs BOTH builds itself, with the build output captured, because
// the build-time warning is half the deliverable: without it the change turns
// a served file into a production 404 with nothing saying why. Capturing the
// output is the only thing that pins which directories the build actually
// scans - a scan aimed at the wrong path finds nothing and stays green under
// every other assertion here.

import { fileURLToPath } from 'node:url';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8811;
const OPTIN_PORT = 8812;
const MARKER = 'leaked-if-served';

const fixtureDir = fileURLToPath(new URL('../fixture/', import.meta.url));

// The build-selecting variables are pinned exactly as test/live/run.mjs pins
// them: either one left exported in the shell redirects the build elsewhere
// and leaves the output this suite asserts against untouched.
const buildEnv = (own) => ({
	...process.env,
	ADAPTER: 'bunserve',
	NO_WS: '',
	STATIC_DOTFILES: '',
	NODE_ENV: 'production',
	...own
});

/**
 * Build the fixture and return everything the build printed.
 *
 * @param {Record<string, string>} env
 * @returns {Promise<string>}
 */
async function build(env) {
	const proc = Bun.spawn([process.execPath, 'run', 'build'], {
		cwd: fixtureDir,
		env: buildEnv(env),
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	]);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`fixture build failed (exit ${code})\n${out}\n${err}`);
	}
	return out + err;
}

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/**
 * Boot one built fixture and hand its base URL to `body`, always stopping the
 * server afterwards - a leaked server holds the port and the NEXT run of this
 * suite refuses to start.
 *
 * @param {string} out - the adapter output directory to run
 * @param {number} port
 * @param {(base: string) => Promise<void>} body
 */
async function withServer(out, port, body) {
	await assertPortFree(port);
	const proc = Bun.spawn([process.execPath, buildPath(out)], {
		env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }),
		stdout: 'pipe',
		stderr: 'pipe'
	});
	try {
		await waitForServer(proc, port);
		await body(`http://127.0.0.1:${port}`);
	} finally {
		proc.kill();
		await proc.exited;
	}
}

/**
 * A path that must not be served: any status but 200, and the marker must not
 * appear in the body whatever the status is.
 *
 * @param {string} base
 * @param {string} label
 * @param {string} path
 */
async function refuses(base, label, path) {
	const res = await fetch(base + path);
	const text = await res.text();
	check(`${label}: not served`, res.status === 404, `status ${res.status}`);
	check(`${label}: body carries no secret`, !text.includes(MARKER));
}

console.log('\n-- the build says what it will refuse');

const defaultLog = await build({});
// Named offenders, from the real output tree the runtime will index - a scan
// pointed at a directory the build does not write finds nothing and would
// leave this whole suite green while the developer got no warning at all.
check('the build warns about the dotfiles it wrote', defaultLog.includes('dotfiles are refused by default'),
	defaultLog.slice(-400));
for (const offender of ['.htpasswd', '.well-known/.nested-secret', 'deep/.hidden.txt']) {
	check(`the warning names ${offender}`, defaultLog.includes(offender), defaultLog.slice(-400));
}
check('the warning names the remedy', defaultLog.includes('staticDotfiles: true'), defaultLog.slice(-400));
check('the warning does not name a served .well-known file',
	!defaultLog.includes('.well-known/probe.txt'), defaultLog.slice(-400));
// A compressed sibling is covered by naming its source file, so the list stays
// proportionate to what the developer actually dropped into static/. Scoped to
// the warning line itself, and only meaningful if there IS one - without the
// guard an absent warning makes this pass rather than fail alongside the check
// above.
const warnAt = defaultLog.indexOf('dotfiles are refused by default');
check('the warning names no .br or .gz sibling',
	warnAt !== -1 && !/\.(?:br|gz)[,\s]/.test(defaultLog.slice(warnAt)),
	defaultLog.slice(-400));

const optinLog = await build({ STATIC_DOTFILES: '1' });
check('the opted-in build is silent about dotfiles',
	!optinLog.includes('dotfiles are refused by default'), optinLog.slice(-400));

await withServer('build', PORT, async (base) => {
	console.log('\n-- default build (dotfiles refused)');

	const control = await fetch(`${base}/test.txt`);
	check('control: an ordinary static file is served', control.status === 200,
		`status ${control.status}`);

	const deep = await fetch(`${base}/deep/plain.txt`);
	check('control: an ordinary nested file is served', deep.status === 200,
		`status ${deep.status}`);

	await refuses(base, 'top-level dotfile', '/.htpasswd');
	await refuses(base, 'nested dotfile', '/deep/.hidden.txt');
	await refuses(base, 'dotfile inside .well-known', '/.well-known/.nested-secret');

	// The exclusion happens at index time, so there is no per-request check for
	// an encoded form to slip past - the decoded key simply is not in the cache.
	await refuses(base, 'percent-encoded dotfile', '/%2Ehtpasswd');
	await refuses(base, 'percent-encoded nested dotfile', '/deep/%2Ehidden.txt');

	const wellKnown = await fetch(`${base}/.well-known/probe.txt`);
	const wellKnownBody = await wellKnown.text();
	check('.well-known discovery keeps working', wellKnown.status === 200,
		`status ${wellKnown.status}`);
	check('.well-known serves the real bytes', wellKnownBody.includes('well-known probe ok'),
		JSON.stringify(wellKnownBody.slice(0, 40)));

	// HEAD takes the same static lane; a refused path must not answer 200 to it
	// either, which a status-only GET check would not notice.
	const head = await fetch(`${base}/.htpasswd`, { method: 'HEAD' });
	check('HEAD of a dotfile is refused too', head.status === 404, `status ${head.status}`);
});

await withServer('build-dotfiles', OPTIN_PORT, async (base) => {
	console.log('\n-- staticDotfiles: true (opted in)');

	const control = await fetch(`${base}/test.txt`);
	check('opt-in: an ordinary static file is still served', control.status === 200,
		`status ${control.status}`);

	for (const [label, path] of [
		['top-level dotfile', '/.htpasswd'],
		['nested dotfile', '/deep/.hidden.txt'],
		['dotfile inside .well-known', '/.well-known/.nested-secret']
	]) {
		const res = await fetch(base + path);
		const text = await res.text();
		check(`opt-in: ${label} is served`, res.status === 200, `status ${res.status}`);
		check(`opt-in: ${label} carries its bytes`, text.includes(MARKER));
	}

	const wellKnown = await fetch(`${base}/.well-known/probe.txt`);
	check('opt-in: .well-known is unaffected', wellKnown.status === 200,
		`status ${wellKnown.status}`);
});

console.log(`\nstatic-dotfiles-check: ${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}

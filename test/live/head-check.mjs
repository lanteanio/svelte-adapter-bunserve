// HEAD parity, end to end against the real server.
//
// The adapter branches on HEAD in three separate places - the static lane and
// the prerendered lane in server.js, and the SSR path in ssr.js - and until now
// nothing asserted any of them against a running Bun. That matters more here
// than it would elsewhere: Bun answers a method it was not given a handler for
// with 405, so a future move to method-keyed routes would break HEAD silently
// on whichever lane was converted first.
//
// The rule under test is the HTTP one: a HEAD response carries the same status
// and the same headers a GET would, and no body. Content-Length in particular
// must describe the body the GET would have returned, not 0 - a client sizing
// a download off a HEAD probe is the reason the header exists.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8808;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

const base = `http://127.0.0.1:${PORT}`;

/**
 * Fetch a path both ways and assert the pair agrees. Returns nothing; every
 * assertion is reported through `check` so one bad lane does not hide the rest.
 *
 * `deterministic` says whether two requests to this path produce byte-identical
 * bodies. Only then can Content-Length be compared ACROSS the two requests: a
 * dynamic SSR page renders slightly differently each time, and with compression
 * on, that lands as a one-byte difference in the declared length. Comparing it
 * anyway measures the page's variability, not HEAD - it passed on one run of
 * this suite and failed on the next.
 *
 * @param {string} label
 * @param {string} path
 * @param {{ deterministic?: boolean }} [opts]
 */
async function assertHeadMatchesGet(label, path, opts = {}) {
	const get = await fetch(base + path);
	const getBody = await get.text();
	const head = await fetch(base + path, { method: 'HEAD' });
	const headBody = await head.text();

	check(`${label}: HEAD status matches GET`, head.status === get.status,
		`GET ${get.status} vs HEAD ${head.status}`);
	check(`${label}: HEAD carries no body`, headBody === '',
		`got ${JSON.stringify(headBody.slice(0, 40))}`);
	check(`${label}: HEAD keeps the content type`,
		head.headers.get('content-type') === get.headers.get('content-type'),
		`GET ${get.headers.get('content-type')} vs HEAD ${head.headers.get('content-type')}`);

	// Content-Length is only required to be present where the GET declared one;
	// a streamed SSR response legitimately has none. Where it IS declared, and
	// the body is reproducible, it has to describe the GET's body - which is the
	// whole point of a HEAD probe.
	const getLen = get.headers.get('content-length');
	const headLen = head.headers.get('content-length');
	if (opts.deterministic && getLen !== null) {
		check(`${label}: HEAD Content-Length describes the GET body`, headLen === getLen,
			`GET ${getLen} vs HEAD ${headLen} (body was ${getBody.length} chars)`);
	} else if (getLen !== null) {
		// Still assert it is SAYING something, just not that it equals another
		// request's length.
		check(`${label}: HEAD declares a Content-Length`, headLen !== null && Number(headLen) > 0,
			`got ${headLen}`);
	}
}

try {
	await waitForServer(proc, PORT);

	// The three lanes that branch on HEAD, plus the miss case.
	await assertHeadMatchesGet('static asset', '/test.txt', { deterministic: true });
	await assertHeadMatchesGet('prerendered page', '/about/', { deterministic: true });
	await assertHeadMatchesGet('SSR route', '/');
	await assertHeadMatchesGet('health probe', '/healthz', { deterministic: true });
	await assertHeadMatchesGet('readiness probe', '/readyz', { deterministic: true });

	const missing = await fetch(`${base}/definitely-not-here`, { method: 'HEAD' });
	check('a HEAD miss is 404 with no body',
		missing.status === 404 && (await missing.text()) === '',
		`got ${missing.status}`);

	// Not 405: the adapter dispatches on method itself rather than handing Bun a
	// method-keyed route map, and this is the assertion that would catch a
	// regression if that ever changed.
	const head = await fetch(`${base}/`, { method: 'HEAD' });
	check('HEAD on a page is answered, not refused as an unlisted method',
		head.status !== 405, `got ${head.status}`);
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

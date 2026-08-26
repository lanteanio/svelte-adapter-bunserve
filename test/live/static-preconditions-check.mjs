// Conditional static requests, end to end against the real server.
//
// The planner is unit-tested against a synthetic entry, and the entry-building
// half is unit-tested against a real indexed cache - but neither can say what
// Bun actually puts on the wire. A 304 is the case where that gap matters
// most: it has no body, so anything wrong with its headers is invisible to
// every assertion about content, and a runtime that dropped them on a bodiless
// response would leave every revalidating cache worse off with nothing failing.
//
// The precondition answers themselves are here for the same reason. They are
// pure header logic, which is exactly the kind of logic that passes its unit
// test while being handed the wrong header name by its caller.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8817;
const BUILD = buildPath();
const ASSET = '/test.txt';

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

// Identity on every request, so the representation under test is the one whose
// validator was read from the 200 - the per-coding selection is the unit
// lane's subject, and leaving it to whatever fetch negotiates would make these
// assertions depend on which sibling files the fixture happens to carry.
const get = (headers = {}) =>
	fetch(base + ASSET, { headers: { 'accept-encoding': 'identity', ...headers } });

try {
	await waitForServer(proc, PORT);

	const full = await get();
	await full.text();
	const etag = full.headers.get('etag') || '';
	const lastModified = full.headers.get('last-modified') || '';
	check('the asset is served with a validator', full.status === 200 && etag !== '',
		`status ${full.status} etag ${JSON.stringify(etag)}`);
	check('and with a modification date', lastModified !== '', JSON.stringify(lastModified));

	const notModified = await get({ 'if-none-match': etag });
	check('If-None-Match on the served validator answers 304', notModified.status === 304,
		`status ${notModified.status}`);

	// THE ONE THIS SUITE EXISTS FOR. Compared against the 200 rather than
	// spelled out, so a change to what the asset serves cannot leave the 304
	// behind without this failing.
	for (const name of ['etag', 'cache-control', 'vary', 'last-modified']) {
		check(`the 304 carries ${name}`, notModified.headers.get(name) === full.headers.get(name),
			`304 ${JSON.stringify(notModified.headers.get(name))} vs 200 ${JSON.stringify(full.headers.get(name))}`);
	}
	check('and describes no body', notModified.headers.get('content-type') === null,
		JSON.stringify(notModified.headers.get('content-type')));

	const star = await get({ 'if-none-match': '*' });
	check('If-None-Match: * answers 304', star.status === 304, `status ${star.status}`);

	const list = await get({ 'if-none-match': `W/"other", ${etag}` });
	check('a list naming the validator answers 304', list.status === 304, `status ${list.status}`);

	// Weak comparison: the same opaque tag without the prefix is the same
	// representation, and a cache that stored it that way must be answered.
	const strongSpelling = await get({ 'if-none-match': etag.replace(/^W\//, '') });
	check('the W/ prefix is not load-bearing', strongSpelling.status === 304,
		`status ${strongSpelling.status}`);

	const mismatch = await get({ 'if-none-match': 'W/"not-the-one"' });
	await mismatch.text();
	check('a validator we never issued gets the body', mismatch.status === 200,
		`status ${mismatch.status}`);

	const matched = await get({ 'if-match': etag });
	await matched.text();
	check('If-Match on the served validator serves the body', matched.status === 200,
		`status ${matched.status}`);

	const stale = await get({ 'if-match': 'W/"stale"' });
	check('If-Match on a stale validator answers 412', stale.status === 412, `status ${stale.status}`);

	const servedAt = Date.parse(lastModified);
	const before = new Date(servedAt - 60_000).toUTCString();
	const after = new Date(servedAt + 60_000).toUTCString();

	const unmodified = await get({ 'if-unmodified-since': before });
	check('If-Unmodified-Since before the file changed answers 412', unmodified.status === 412,
		`status ${unmodified.status}`);

	const dated = await get({ 'if-modified-since': after });
	check('If-Modified-Since after the file changed answers 304', dated.status === 304,
		`status ${dated.status}`);

	// Date.parse would take this. An HTTP-date parser does not, and an ignored
	// header means the full response - never a 304 the client did not earn.
	const iso = await get({ 'if-modified-since': new Date(servedAt + 60_000).toISOString() });
	await iso.text();
	check('an ISO 8601 string is not an HTTP-date and is ignored', iso.status === 200,
		`status ${iso.status}`);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	if (failed > 0) {
		console.log('\n--- stderr ---\n' + (await new Response(proc.stderr).text()).slice(-1500));
	}
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log('failures:\n  - ' + failures.join('\n  - '));
	process.exit(1);
}

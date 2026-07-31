// The upgrade path must honour the CONFIGURED origin, not one derived from
// request headers. Deriving it takes the scheme from is_tls, which is false
// whenever TLS terminates at a proxy - the standard production shape - so a
// browser's https:// Origin would be compared against a derived http:// self
// origin and every legitimate upgrade would 403. That failure pushes operators
// to allowedOrigins:'any', turning a fail-closed bug into a fail-open config.
//
// Discrimination used below: a DENIED origin returns 403. An ALLOWED origin
// gets past the check and reaches server.upgrade(), which refuses a plain fetch
// that is not a real handshake and yields 400. So 400 means "the origin check
// passed", which is exactly what this needs to prove.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8804;
const BUILD = buildPath();
const ORIGIN = 'https://app.example';

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

// TLS is NOT configured, so is_tls is false and a header-derived origin would
// be http://127.0.0.1:PORT - the proxy-terminated shape this regression covers.
await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ORIGIN }),
	stdout: 'pipe',
	stderr: 'pipe'
});

const upgradeHeaders = (origin) => ({
	upgrade: 'websocket',
	connection: 'Upgrade',
	...(origin ? { origin } : {})
});

try {
	await waitForServer(proc, PORT);

	const matching = await fetch(`http://127.0.0.1:${PORT}/ws`, { headers: upgradeHeaders(ORIGIN) });
	check('an Origin matching the configured ORIGIN is allowed through',
		matching.status !== 403, `got ${matching.status} (403 means the regression is back)`);

	const foreign = await fetch(`http://127.0.0.1:${PORT}/ws`, { headers: upgradeHeaders('https://evil.example') });
	check('a foreign Origin is still refused', foreign.status === 403, `got ${foreign.status}`);

	// The host-derived origin http://127.0.0.1:PORT must NOT be accepted once
	// ORIGIN is configured, or the configured value is decorative.
	const derived = await fetch(`http://127.0.0.1:${PORT}/ws`, { headers: upgradeHeaders(`http://127.0.0.1:${PORT}`) });
	check('the header-derived origin is not silently accepted instead',
		derived.status === 403, `got ${derived.status}`);

	const absent = await fetch(`http://127.0.0.1:${PORT}/ws`, { headers: upgradeHeaders(null) });
	check('a missing Origin is still allowed (non-browser clients)',
		absent.status !== 403, `got ${absent.status}`);
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	proc.kill();
	if (failed > 0) {
		console.log('\n--- stdout ---\n' + (await new Response(proc.stdout).text()).slice(-2000));
		console.log('\n--- stderr ---\n' + (await new Response(proc.stderr).text()).slice(-2000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);

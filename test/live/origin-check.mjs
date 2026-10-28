// The upgrade path must honour the CONFIGURED origin, not one derived from
// request headers. Deriving it takes the scheme from is_tls, which is false
// whenever TLS terminates at a proxy - the standard production shape - so a
// browser's https:// Origin would be compared against a derived http:// self
// origin and every legitimate upgrade would 403. That failure pushes operators
// to allowedOrigins:'any', turning a fail-closed bug into a fail-open config.
//
// Discrimination used below: each is a complete handshake over a raw socket,
// so a DENIED origin is answered 403 and an ALLOWED one opens: 101.

import { HANDSHAKE } from '../helpers/handshake.mjs';
import { assertPortFree, buildPath, rawExchange, serverEnv, waitForServer } from './harness.mjs';

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

/** @param {string | null} origin */
const handshakeStatus = async (origin) =>
	(await rawExchange(PORT, Object.entries({ ...HANDSHAKE, ...(origin ? { origin } : {}) }))).status;

try {
	await waitForServer(proc, PORT);

	const matching = await handshakeStatus(ORIGIN);
	check('an Origin matching the configured ORIGIN is allowed through',
		matching === 101, `got ${matching} (403 means the regression is back)`);

	const foreign = await handshakeStatus('https://evil.example');
	check('a foreign Origin is still refused', foreign === 403, `got ${foreign}`);

	// The host-derived origin http://127.0.0.1:PORT must NOT be accepted once
	// ORIGIN is configured, or the configured value is decorative.
	const derived = await handshakeStatus(`http://127.0.0.1:${PORT}`);
	check('the header-derived origin is not silently accepted instead',
		derived === 403, `got ${derived}`);

	const absent = await handshakeStatus(null);
	check('a missing Origin is still allowed (non-browser clients)',
		absent === 101, `got ${absent}`);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// `TRUSTED_PROXIES` SET, AND NOT NAMING THE REAL PROXY.
//
// Its own file because the allowlist is built once at module load, and its own
// case because it is the collapse nothing else can report: the header is
// present on every request, so the "did it arrive" question answers yes; the
// claim is ignored because the peer is not on the list, so every client meters
// as that one peer; and the boot warning stays silent because TRUSTED_PROXIES
// IS set. A typo in a CIDR, or a proxy that moved, produces exactly this and
// looks like nothing.
//
// The same branch is ordinary for a client connecting directly to a server that
// is also reachable through its proxy - which is why the advisory says what was
// ignored and why, rather than asserting a misconfiguration.

process.env.ADDRESS_HEADER = 'x-forwarded-for';
process.env.TRUSTED_PROXIES = '10.9.9.9';
delete process.env.XFF_DEPTH;
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true
}).options;

/** @type {string[]} */
const bootWarnings = [];
const realWarn = console.warn;
console.warn = (...args) => { bootWarnings.push(args.join(' ')); };
const { warnRateLimitProxyCollapse, resolveRateLimitAddress, UPGRADE_DOOR } =
	await import('../../src/runtime/handler/rate-limit.js');
console.warn = realWarn;

const request = (headers) => new Request('http://sim.invalid/ws', { headers });

function captureWarn(fn) {
	const original = console.warn;
	/** @type {string[]} */
	const lines = [];
	console.warn = (...args) => { lines.push(args.join(' ')); };
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return lines.join('\n');
}

test('the allowlist is in force and says nothing at boot', () => {
	// The premise, and the reason this configuration is invisible: with an
	// allowlist set, the boot warning about an unauthenticated header key does
	// not apply and is not printed.
	assert.equal(bootWarnings.join('\n'), '');
});

test('a claim from a peer the allowlist does not name is ignored, and said out loud', () => {
	const { address, source } = resolveRateLimitAddress(
		request({ 'x-forwarded-for': '203.0.113.7' }),
		'10.0.0.1'
	);
	assert.equal(source, 'header-untrusted');
	assert.equal(address, '10.0.0.1', 'the peer, because the claim was not honoured');
	const warned = captureWarn(() => warnRateLimitProxyCollapse(source, address, UPGRADE_DOOR));
	assert.match(warned, /is not in\n?\s*TRUSTED_PROXIES/);
	assert.match(warned, /EVERY client meters as that one address/);
	assert.match(warned, /The limit is `websocket\.upgradeRateLimit`/);
});

test('and a claim from the named proxy is honoured, silently', () => {
	const { address, source } = resolveRateLimitAddress(
		request({ 'x-forwarded-for': '203.0.113.7' }),
		'10.9.9.9'
	);
	assert.equal(source, 'header');
	assert.equal(address, '203.0.113.7');
	assert.equal(captureWarn(() => warnRateLimitProxyCollapse(source, address, UPGRADE_DOOR)), '');
});

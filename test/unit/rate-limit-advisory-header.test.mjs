import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The same advisory on a deployment that DID configure `ADDRESS_HEADER`.
//
// Its own file because the header is read once at module load, and because the
// advisory latches per door - so the configured-and-arriving case and the
// configured-and-missing case cannot both be driven through one door here.

process.env.ADDRESS_HEADER = 'x-forwarded-for';
delete process.env.TRUSTED_PROXIES;
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true
}).options;

// Captured across the IMPORT, because the boot warning below is written while
// the module body runs and there is no later moment to observe it from.
/** @type {string[]} */
const bootWarnings = [];
const realWarn = console.warn;
console.warn = (...args) => { bootWarnings.push(args.join(' ')); };
const { warnRateLimitProxyCollapse, UPGRADE_DOOR, AUTH_DOOR } =
	await import('../../src/runtime/handler/rate-limit.js');
console.warn = realWarn;

const request = (headers) => new Request('http://sim.invalid/ws', { headers });

/** Run `fn` and return everything it wrote to stderr. */
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

test('a configured header that never arrives is still a collapse', () => {
	// The resolver falls back to the socket peer rather than throwing, so the
	// deployment believes it is metering clients while it is metering its
	// gateway. Testing only that the header is CONFIGURED - which is what the
	// guard used to do - suppresses the advisory in exactly the case where the
	// configuration is not working.
	const warned = captureWarn(() =>
		warnRateLimitProxyCollapse(request({}), '10.0.0.4', UPGRADE_DOOR)
	);
	assert.match(warned, /refused a WebSocket upgrade \(429\)/);
	assert.match(warned, /ADDRESS_HEADER is set to `x-forwarded-for`, but this request did not carry it/);
	assert.match(warned, /The limit is `websocket\.upgradeRateLimit`/);
});

test('a configured header that does arrive says nothing', () => {
	// The address being private is not the point once the header is working: an
	// internal deployment can legitimately meter private clients.
	assert.equal(
		captureWarn(() =>
			warnRateLimitProxyCollapse(
				request({ 'x-forwarded-for': '203.0.113.7' }),
				'203.0.113.7',
				AUTH_DOOR
			)
		),
		''
	);
});

test('an unauthenticated header key is called out at boot', () => {
	// `ADDRESS_HEADER` without `TRUSTED_PROXIES` makes the bucket key a string
	// the client chooses: a fresh one per request reaches no limit, and a
	// victim's address spends theirs. Nothing at request time looks wrong -
	// refusals still happen, at the configured rate, to whoever the key says -
	// so the place to say it is boot, while an operator is still reading.
	const boot = bootWarnings.join('\n');
	assert.match(boot, /ADDRESS_HEADER is set to `x-forwarded-for` and TRUSTED_PROXIES is not/);
	assert.match(boot, /a value any client can choose/);
	assert.match(boot, /Set\n?\s*TRUSTED_PROXIES/);
	assert.equal(bootWarnings.length, 1, 'once, at boot, not per request');
});

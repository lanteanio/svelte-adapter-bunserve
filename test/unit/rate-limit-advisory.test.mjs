import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The advisory a 429 carries for the OPERATOR: this server may be metering
// every client as one.
//
// It is latched, so each case below is a one-shot and the order is the test.
// `ADDRESS_HEADER` is unset here, which is the deployment shape the advisory was
// originally written for; the file beside this one covers the configured-header
// shapes.

process.env.ADDRESS_HEADER = '';
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true
}).options;

const { warnRateLimitProxyCollapse, UPGRADE_DOOR, AUTH_DOOR } =
	await import('../../src/runtime/handler/rate-limit.js');

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

test('no resolvable client address is the total collapse, and says so', () => {
	// `requestIP` answering null keys every client on the empty string, so the
	// whole server shares one bucket. Nothing about that key looks private or
	// loopback, which is how it went unmentioned: the scope test that gated this
	// advisory answers 'unknown' and returned.
	const warned = captureWarn(() => warnRateLimitProxyCollapse(request({}), '', AUTH_DOOR));
	assert.match(warned, /refused an auth preflight \(429\)/);
	assert.match(warned, /no client address could be resolved/);
	assert.match(warned, /EVERY client shares one bucket/);
	assert.match(warned, /The limit is `websocket\.authPathRateLimit`/);
});

test('a public client address says nothing', () => {
	// A server facing the internet directly sees real addresses and is metering
	// exactly what it means to.
	assert.equal(
		captureWarn(() => warnRateLimitProxyCollapse(request({}), '203.0.113.7', UPGRADE_DOOR)),
		''
	);
});

test('the other door gets its own advisory, naming its own knob', () => {
	// THE LATCH IS PER DOOR. The auth door has already spoken above; a single
	// latch for the process would leave this one silent, and an operator chasing
	// upgrade 429s would read an advisory about `authPathRateLimit`, change it,
	// and see no difference.
	const warned = captureWarn(() => warnRateLimitProxyCollapse(request({}), '127.0.0.1', UPGRADE_DOOR));
	assert.match(warned, /refused a WebSocket upgrade \(429\)/);
	assert.match(warned, /the client address is loopback \(127\.0\.0\.1\)/);
	assert.match(warned, /The limit is `websocket\.upgradeRateLimit`/);
	assert.doesNotMatch(warned, /authPathRateLimit/);
});

test('and each door says it once, however many refusals follow', () => {
	assert.equal(
		captureWarn(() => {
			warnRateLimitProxyCollapse(request({}), '127.0.0.1', UPGRADE_DOOR);
			warnRateLimitProxyCollapse(request({}), '10.0.0.4', UPGRADE_DOOR);
			warnRateLimitProxyCollapse(request({}), '', AUTH_DOOR);
		}),
		''
	);
});

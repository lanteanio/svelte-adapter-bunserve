import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The advisory a 429 carries for the OPERATOR: this server may be metering
// every client as one.
//
// It is driven by WHERE THE KEY CAME FROM, not by re-reading the request.
// Re-deriving it can only approximate - a chain shorter than XFF_DEPTH and one
// past the size ceiling both arrive with the header present, and both meter
// every client on the server as the gateway - so the resolver reports its own
// branch and this decides from that.
//
// `ADDRESS_HEADER` is unset here, so `resolveRateLimitAddress` always answers
// 'peer'; the file beside this one covers the configured-header sources. The
// latch is per door AND per cause, so each case below is one shot of its own.

process.env.ADDRESS_HEADER = '';
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true
}).options;

const { warnRateLimitProxyCollapse, resolveRateLimitAddress, UPGRADE_DOOR, AUTH_DOOR } =
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

test('with no header configured every key comes from the peer', () => {
	// The premise the rest of the file rests on, asserted rather than assumed.
	const resolved = resolveRateLimitAddress(request({ 'x-forwarded-for': '203.0.113.9' }), '10.0.0.4');
	assert.deepEqual(resolved, { address: '10.0.0.4', source: 'peer' });
});

test('no resolvable client address is the total collapse, and says so', () => {
	// `requestIP` answering null keys every client on the empty string, so the
	// whole server shares one bucket. Nothing about that key looks private or
	// loopback, which is how it went unmentioned: the scope test that gated this
	// advisory answers 'unknown' and returned.
	const warned = captureWarn(() => warnRateLimitProxyCollapse('peer', '', AUTH_DOOR));
	assert.match(warned, /refused an auth preflight \(429\)/);
	assert.match(warned, /no client address could be resolved/);
	assert.match(warned, /EVERY client shares one bucket/);
	assert.match(warned, /The limit is `websocket\.authPathRateLimit`/);
});

test('a public client address says nothing', () => {
	// A server facing the internet directly sees real addresses and is metering
	// exactly what it means to.
	assert.equal(
		captureWarn(() => warnRateLimitProxyCollapse('peer', '203.0.113.7', UPGRADE_DOOR)),
		''
	);
});

test('the other door gets its own advisory, naming its own knob', () => {
	// THE LATCH IS PER DOOR. The auth door has already spoken above; a single
	// latch for the process would leave this one silent, and an operator chasing
	// upgrade 429s would read an advisory about `authPathRateLimit`, change it,
	// and see no difference.
	const warned = captureWarn(() => warnRateLimitProxyCollapse('peer', '127.0.0.1', UPGRADE_DOOR));
	assert.match(warned, /refused a WebSocket upgrade \(429\)/);
	assert.match(warned, /the client address is loopback \(127\.0\.0\.1\)/);
	assert.match(warned, /The limit is `websocket\.upgradeRateLimit`/);
	assert.doesNotMatch(warned, /authPathRateLimit/);
});

test('each door says each cause once, however many refusals follow', () => {
	assert.equal(
		captureWarn(() => {
			warnRateLimitProxyCollapse('peer', '127.0.0.1', UPGRADE_DOOR);
			warnRateLimitProxyCollapse('peer', '127.0.0.2', UPGRADE_DOOR);
			warnRateLimitProxyCollapse('peer', '', AUTH_DOOR);
		}),
		''
	);
});

test('but a DIFFERENT cause on a door that has already spoken is still said', () => {
	// The latch is per cause, not per door alone, because some of these are
	// reachable by a client - an empty header value is one request away. A single
	// latch per door would let anyone spend it and leave the deployment's real
	// collapse permanently unmentionable.
	const warned = captureWarn(() => warnRateLimitProxyCollapse('peer', '', UPGRADE_DOOR));
	assert.match(warned, /no client address could be resolved/);
	assert.match(warned, /refused a WebSocket upgrade/);
	// And a private peer is its own cause again, distinct from loopback.
	const privateWarn = captureWarn(() => warnRateLimitProxyCollapse('peer', '10.0.0.4', UPGRADE_DOOR));
	assert.match(privateWarn, /the client address is private \(10\.0\.0\.4\)/);
});

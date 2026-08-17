import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The same advisory on a deployment that DID configure `ADDRESS_HEADER`, and
// the resolver that tells it which branch was taken.
//
// Its own file because the header and the depth are read once at module load.
// `XFF_DEPTH` is 2 here on purpose: the shape where the header ARRIVES on every
// request and is still unusable - a chain shorter than the configured depth -
// is a total, permanent collapse that an advisory re-deriving its own answer
// from the request cannot see, because the header is present.

process.env.ADDRESS_HEADER = 'x-forwarded-for';
process.env.XFF_DEPTH = '2';
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
const { warnRateLimitProxyCollapse, resolveRateLimitAddress, UPGRADE_DOOR, AUTH_DOOR } =
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

/** The advisory for one refusal, driven end to end from the resolver. */
function adviseFor(headers, peer, door) {
	const { address, source } = resolveRateLimitAddress(request(headers), peer);
	return { source, address, warned: captureWarn(() => warnRateLimitProxyCollapse(source, address, door)) };
}

test('a chain shorter than the depth is unusable, and the header being present hides it', () => {
	// THE ONE THE OLD SHAPE COULD NOT SEE. One proxy appends one entry, XFF_DEPTH
	// says two, so the claim is not honoured and every client on the server
	// meters as the gateway - permanently. The header arrived, so an advisory
	// that asked the request "did it arrive?" returned silently.
	const { source, address, warned } = adviseFor({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.4', UPGRADE_DOOR);
	assert.equal(source, 'header-unusable', 'the resolver says which branch it took');
	assert.equal(address, '10.0.0.4', 'and that it fell back to the peer');
	assert.match(warned, /could not be read at the configured\n?\s*depth/);
	assert.match(warned, /XFF_DEPTH/);
});

test('a configured header that never arrives is still a collapse', () => {
	const { source, warned } = adviseFor({}, '10.0.0.4', AUTH_DOOR);
	assert.equal(source, 'header-absent');
	assert.match(warned, /refused an auth preflight \(429\)/);
	assert.match(warned, /did not carry it/);
	assert.match(warned, /The limit is `websocket\.authPathRateLimit`/);
});

test('a header that arrives and is read says nothing', () => {
	// The healthy configured deployment: two hops, depth two, the claim honoured.
	const { source, address, warned } = adviseFor(
		{ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
		'10.0.0.1',
		UPGRADE_DOOR
	);
	assert.equal(source, 'header');
	assert.equal(address, '203.0.113.7', 'the client, not the gateway');
	assert.equal(warned, '');
});

test('an empty header value is reported as the client-chosen thing it is', () => {
	// Reachable by anyone, with ADDRESS_HEADER set and no allowlist: send the
	// header empty and every such client shares the empty bucket. It is a real
	// collapse and worth saying - but it must not be reported as "the runtime
	// could not resolve an address", which would be a false diagnosis an attacker
	// gets to put in the operator's log.
	const { source, address, warned } = adviseFor(
		{ 'x-forwarded-for': ' , ' },
		'10.0.0.1',
		UPGRADE_DOOR
	);
	assert.equal(source, 'header');
	assert.equal(address, '');
	assert.match(warned, /value this request carried was empty/);
	assert.doesNotMatch(warned, /no client address could be resolved/);
});

test('and spending that latch leaves the deployment-level ones intact', () => {
	// The amplification concern, stated as an assertion: a client that can reach
	// one cause must not be able to silence the others.
	const absent = adviseFor({}, '10.0.0.4', UPGRADE_DOOR);
	assert.match(absent.warned, /did not carry it/);
	const unusable = adviseFor({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.4', AUTH_DOOR);
	assert.match(unusable.warned, /could not be read at the configured/);
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
	assert.equal(bootWarnings.length, 1, 'once, at boot, not per request');
});

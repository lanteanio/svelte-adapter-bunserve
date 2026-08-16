import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// The forwarded-chain depth, which decides WHICH hop in an `X-Forwarded-For`
// this deployment trusts. It is read once at module load, so a file that means
// to exercise a depth other than the default needs to be that file - which is
// all this one is.
//
// Depth 3 says: three proxies of ours appended to this chain, so the client is
// the third entry from the end. Anything the client itself put in front of that
// is not ours and is not read.

process.env.ADDRESS_HEADER = 'x-forwarded-for';
process.env.XFF_DEPTH = '3';
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = normalizeWsOptions({
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	allowUnauthenticatedSubscribe: true
}).options;

const { rateLimitAddress } = await import('../../src/runtime/handler/rate-limit.js');

const request = (headers) => new Request('http://sim.invalid/ws', { headers });

test('the hop is counted from the end at the configured depth', () => {
	assert.equal(
		rateLimitAddress(request({ 'x-forwarded-for': 'client, edge, mid, near' }), '10.1.1.1'),
		'edge'
	);
});

test('a chain shorter than the configured depth is not honoured', () => {
	// The chain is not the one this deployment was configured for, so the claim
	// is ignored rather than read at whatever offset happens to exist. Reading
	// it anyway would meter on a value the client fully controls - it would sit
	// in front of our proxies' entries, which is exactly the position an
	// attacker can write.
	assert.equal(rateLimitAddress(request({ 'x-forwarded-for': '1.1.1.1' }), '10.1.1.1'), '10.1.1.1');
	assert.equal(
		rateLimitAddress(request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), '10.1.1.1'),
		'10.1.1.1'
	);
});

test('a chain exactly the configured depth is honoured', () => {
	assert.equal(
		rateLimitAddress(request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }), '10.1.1.1'),
		'1.1.1.1'
	);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';

// DUPLICATE FORWARDED HEADERS ARE ONE CHAIN, and the hop the limiters key on
// must not move when a chain arrives as two headers instead of one.
//
// Per the Fetch spec, duplicate headers on a request read back as their values
// joined with ', ' - which for X-Forwarded-For is exactly the concatenation the
// header's own semantics call for, since every proxy that appends a hop is
// appending to one logical list. The hop this module selects is counted from
// the END of that list, and the end is the only part a client cannot write:
// whatever a client sends arrives BEFORE anything a trusted proxy appends, so a
// forged prefix - as extra text or as extra whole headers - lengthens the
// chain's left edge and never moves its right one.
//
// Pinned against requests carrying genuinely DUPLICATE headers rather than one
// pre-joined value, because the joining is the behaviour under test: a runtime
// that surfaced only the last duplicate would show this module a shorter chain,
// and the same XFF_DEPTH would select a different hop - the identity both rate
// limiters key on.

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

const realWarn = console.warn;
console.warn = () => {};
const { resolveRateLimitAddress } = await import('../../src/runtime/handler/rate-limit.js');
console.warn = realWarn;

/** @param {[string, string][]} pairs */
const request = (pairs) => new Request('http://sim.invalid/ws', { headers: pairs });

test('the Headers contract this file rests on: duplicates read back joined', () => {
	// Asserted first so a runtime that stopped joining fails HERE, by name,
	// rather than as a hop-selection mystery three tests later.
	const joined = request([
		['x-forwarded-for', '203.0.113.9'],
		['x-forwarded-for', '198.51.100.7']
	]).headers.get('x-forwarded-for');
	assert.equal(joined, '203.0.113.9, 198.51.100.7');
});

test('two forwarded headers select the same hop as the joined chain they mean', () => {
	const asTwoHeaders = resolveRateLimitAddress(
		request([
			['x-forwarded-for', '203.0.113.9, 10.1.1.1'],
			['x-forwarded-for', '198.51.100.7']
		]),
		'10.0.0.4'
	);
	const asOneHeader = resolveRateLimitAddress(
		request([['x-forwarded-for', '203.0.113.9, 10.1.1.1, 198.51.100.7']]),
		'10.0.0.4'
	);
	assert.equal(asTwoHeaders.source, 'header');
	assert.equal(asTwoHeaders.address, asOneHeader.address, 'one chain, however many headers spell it');
	assert.equal(asTwoHeaders.address, '10.1.1.1', 'XFF_DEPTH=2 counts from the end of the WHOLE chain');
});

test('a client-sent extra header lengthens the left edge and moves nothing', () => {
	// The security property. The client's forgery arrives as its own header
	// BEFORE the trusted proxy's, so the joined chain grows at the front - and
	// depth-from-the-end still lands on the hop the proxy vouched for.
	const honest = resolveRateLimitAddress(
		request([['x-forwarded-for', '203.0.113.9, 198.51.100.7']]),
		'10.0.0.4'
	);
	const forged = resolveRateLimitAddress(
		request([
			['x-forwarded-for', '6.6.6.6, 7.7.7.7'],
			['x-forwarded-for', '203.0.113.9, 198.51.100.7']
		]),
		'10.0.0.4'
	);
	assert.equal(honest.address, '203.0.113.9');
	assert.equal(forged.address, honest.address, 'the forged prefix is metered as nothing');
	assert.equal(forged.source, 'header');
});

test('the size ceiling reads the joined value, so duplicates cannot sneak past it', () => {
	// Two headers under the ceiling each, over it together. The joined chain is
	// what gets split and trimmed, so the joined chain is what the ceiling has
	// to be measured against.
	const half = `${'1.2.3.4, '.repeat(512)}9.9.9.9`;
	const { source, address } = resolveRateLimitAddress(
		request([
			['x-forwarded-for', half],
			['x-forwarded-for', half]
		]),
		'10.0.0.4'
	);
	assert.equal(source, 'header-unusable', 'not a chain any proxy produced');
	assert.equal(address, '10.0.0.4', 'metering falls back to the peer');
});

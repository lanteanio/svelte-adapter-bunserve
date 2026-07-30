import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrustedProxyMatcher } from '../../src/runtime/utils/trusted-proxies.js';

test('empty spec disables matching (null)', () => {
	assert.equal(createTrustedProxyMatcher(''), null);
	assert.equal(createTrustedProxyMatcher('  ,  '), null);
});

test('exact IPv4 match', () => {
	const m = createTrustedProxyMatcher('10.0.0.5');
	assert.ok(m.match('10.0.0.5'));
	assert.ok(!m.match('10.0.0.6'));
});

test('IPv4 CIDR match', () => {
	const m = createTrustedProxyMatcher('10.0.0.0/8');
	assert.ok(m.match('10.255.1.2'));
	assert.ok(!m.match('11.0.0.1'));
});

test('IPv4-mapped IPv6 socket address matches an IPv4 rule', () => {
	const m = createTrustedProxyMatcher('10.0.0.0/8');
	assert.ok(m.match('::ffff:10.1.2.3'));
});

test('IPv6 exact and CIDR', () => {
	const m = createTrustedProxyMatcher('::1, 2001:db8::/32');
	assert.ok(m.match('::1'));
	assert.ok(m.match('[::1]'));
	assert.ok(m.match('2001:db8:1234::9'));
	assert.ok(!m.match('2001:db9::1'));
});

test('zone id is stripped before matching', () => {
	const m = createTrustedProxyMatcher('fe80::/10');
	assert.ok(m.match('fe80::1%eth0'));
});

test('/0 matches everything of its family', () => {
	const m4 = createTrustedProxyMatcher('0.0.0.0/0');
	assert.ok(m4.match('203.0.113.7'));
	assert.ok(!m4.match('2001:db8::1'));
});

test('malformed entries throw at boot', () => {
	assert.throws(() => createTrustedProxyMatcher('not-an-ip'));
	assert.throws(() => createTrustedProxyMatcher('10.0.0.0/33'));
	assert.throws(() => createTrustedProxyMatcher('2001:db8::/129'));
});

test('unparseable runtime input never matches', () => {
	const m = createTrustedProxyMatcher('10.0.0.0/8');
	assert.ok(!m.match('garbage'));
	assert.ok(!m.match(''));
});

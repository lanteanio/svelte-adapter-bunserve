import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitKey, createSlidingWindowLimiter } from '../../src/runtime/utils/rate-limiter.js';

// HOW A CLIENT BECOMES A RATE-LIMIT BUCKET.
//
// Keying on the full address is the obvious answer and the wrong one: a /64 is
// the standard allocation from every major host and most residential ISPs, so
// an attacker with one routed block sources each request from a fresh /128,
// never collides with itself, and drives the door at full server speed while
// the limiter records one request per identity. A 6to4 site gets a whole /48,
// so that prefix folds one group further.
//
// The opposite error is worse, and most of this file is about not making it.
// Folding something that is NOT a global IPv6 address merges unrelated clients
// into one bucket: `::ffff:1.2.3.4` is what an IPv4 client can look like on a
// dual-stack listener, and its /64 is shared by the entire IPv4 internet.

const KEY_LEN = 64;
const key = (ip) => rateLimitKey(ip, KEY_LEN);

test('a global IPv6 address folds to its first four groups', () => {
	assert.equal(key('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::');
});

test('every address in one /64 gets the same bucket', () => {
	// The exploit, stated as an assertion.
	assert.equal(key('2001:db8:1:2::1'), key('2001:db8:1:2:ffff:ffff:ffff:ffff'));
});

test('different /64s stay apart', () => {
	assert.notEqual(key('2001:db8:1:2::1'), key('2001:db8:1:3::1'));
});

test('case, leading zeros and elision all reach one key', () => {
	assert.equal(key('2001:0DB8:0001:0002::1'), '2001:db8:1:2::');
});

test('brackets and a port are stripped', () => {
	assert.equal(key('[2001:db8:1:2::1]:443'), '2001:db8:1:2::');
});

test('a 6to4 site folds to its /48 allocation', () => {
	assert.equal(key('2002:c000:0204:1::1'), '2002:c000:204::');
	assert.equal(key('2002:c000:0204:ffff::1'), '2002:c000:204::');
	assert.notEqual(key('2002:c000:0204::1'), key('2002:c000:0205::1'));
});

test('IPv4 is left alone', () => {
	assert.equal(key('203.0.113.7'), '203.0.113.7');
	assert.notEqual(key('203.0.113.7'), key('203.0.113.8'));
});

test('IPv4-mapped IPv6 is left alone', () => {
	// A dual-stack listener can report every IPv4 client this way. Folding it
	// would put the whole IPv4 internet in one bucket.
	assert.notEqual(key('::ffff:203.0.113.7'), key('::ffff:203.0.113.8'));
});

test('the hex spelling of IPv4-mapped is left alone', () => {
	assert.notEqual(key('::ffff:cb00:7107'), key('::ffff:cb00:7108'));
});

test('loopback and the unspecified address are left alone', () => {
	assert.notEqual(key('::1'), key('::2'));
});

test('a fully expanded IPv4-mapped address is left alone', () => {
	// The shape a dual-stack listener can emit instead of the `::ffff:` form.
	// Which one this runtime emits is not relied on: both decline to fold.
	assert.notEqual(
		key('0000:0000:0000:0000:0000:ffff:7f00:0001'),
		key('0000:0000:0000:0000:0000:ffff:7f00:0002')
	);
});

test('NAT64 is left alone, where one /64 is the whole translated IPv4 internet', () => {
	// Behind a translator every IPv4 client arrives as 64:ff9b::a.b.c.d, so
	// folding would lock out every IPv4 user of the deployment at the tenth
	// upgrade.
	assert.notEqual(key('64:ff9b::198.51.100.7'), key('64:ff9b::203.0.113.9'));
	assert.notEqual(key('64:ff9b:1:0:0:0:8.8.8.8'), key('64:ff9b:1:0:0:0:1.1.1.1'));
});

test('Teredo is left alone, where the /64 identifies the relay', () => {
	assert.notEqual(
		key('2001:0:53aa:64c:1c:2b0f:3f57:fefd'),
		key('2001:0:53aa:64c:28dd:1d2c:3f57:fe01')
	);
});

test('link-local is left alone, where one /64 is an entire LAN', () => {
	assert.notEqual(key('fe80::1'), key('fe80::2'));
	assert.notEqual(key('febf::1'), key('febf::2'));
});

test('a malformed tail does not fold into a real prefix', () => {
	// With ADDRESS_HEADER set the value is client-supplied, so folding a crafted
	// one would let an attacker land in a real client's bucket and spend its
	// allowance.
	assert.notEqual(key('2001:db8:1:2:zz:zz:zz:zz'), key('2001:db8:1:2::1'));
});

test('a zone-qualified value does not fold into a real prefix', () => {
	assert.notEqual(key('2001:db8:1:2::1%eth0'), key('2001:db8:1:2::2'));
});

test('garbage after a bracketed literal is refused rather than ignored', () => {
	const victim = key('[2001:db8:1:2::1]:443');
	assert.notEqual(key('[2001:db8:1:2::1]attacker'), victim);
	assert.notEqual(key('[2001:db8:1:2::1]:not-a-port'), victim);
	assert.notEqual(key('[2001:db8:1:2::1]:65536'), victim);
});

test('IPv4 with a port is left alone', () => {
	assert.notEqual(key('203.0.113.7:5678'), key('203.0.113.8:5678'));
});

test('an opaque header value is left alone', () => {
	// With ADDRESS_HEADER set the value need not be an address at all.
	assert.equal(key('user-42'), 'user-42');
	assert.equal(key('a:b:c'), 'a:b:c');
});

test('a malformed IPv6 is left alone rather than guessed at', () => {
	assert.equal(key('2001:db8:::1'), '2001:db8:::1');
	assert.equal(key('2001:db8:1:2:3:4:5:6:7:8'), '2001:db8:1:2:3:4:5:6:7:8');
	assert.equal(key('2001:db8:1:2:3:4:5:zz'), '2001:db8:1:2:3:4:5:zz');
});

test('the key length is bounded', () => {
	assert.equal(key('x'.repeat(200)).length, KEY_LEN);
});

// - The limiter over those keys ------------------------------------------------

function limiter(overrides) {
	return createSlidingWindowLimiter({
		maxPerWindow: 10,
		windowMs: 10_000,
		maxEntries: 1000,
		evictionSample: 16,
		maxKeyLen: KEY_LEN,
		...overrides
	});
}

test('a flood sourced from fresh addresses in one /64 is metered as one client', () => {
	const l = limiter();
	let admitted = 0;
	for (let i = 0; i < 100; i++) {
		if (!l.exceeded(`2001:db8:1:2::${i.toString(16)}`, 1000)) admitted++;
	}
	assert.equal(admitted, 10);
	assert.equal(l.map.size, 1);
});

test('one /64 cannot spend another /64 allowance', () => {
	const l = limiter();
	for (let i = 0; i < 100; i++) l.exceeded(`2001:db8:1:2::${i.toString(16)}`, 1000);
	assert.equal(l.exceeded('2001:db8:1:3::1', 1000), false);
});

test('a flood rotating through one 6to4 /48 is metered as one client', () => {
	const l = limiter();
	let admitted = 0;
	for (let subnet = 0; subnet < 100; subnet++) {
		if (!l.exceeded(`2002:c000:0204:${subnet.toString(16)}::1`, 1000)) admitted++;
	}
	assert.equal(admitted, 10);
	assert.equal(l.map.size, 1);
});

test('distinct IPv4 clients are still metered separately', () => {
	// The over-merge check: 100 different addresses are 100 buckets.
	const l = limiter();
	let admitted = 0;
	for (let i = 0; i < 100; i++) {
		if (!l.exceeded(`203.0.113.${i}`, 1000)) admitted++;
	}
	assert.equal(admitted, 100);
	assert.equal(l.map.size, 100);
});

test('distinct IPv4-mapped clients are still metered separately', () => {
	const l = limiter();
	let admitted = 0;
	for (let i = 0; i < 100; i++) {
		if (!l.exceeded(`::ffff:203.0.113.${i}`, 1000)) admitted++;
	}
	assert.equal(admitted, 100);
});

test('a limit of zero admits everything without recording anything', () => {
	// The documented spelling for "off". It has to short-circuit before the map,
	// or a disabled limiter would still grow one entry per client.
	const l = limiter({ maxPerWindow: 0 });
	for (let i = 0; i < 100; i++) assert.equal(l.exceeded('203.0.113.7', 1000), false);
	assert.equal(l.map.size, 0);
});

test('the previous window fades out rather than dropping at a boundary', () => {
	// What a fixed window gets wrong: a client places its whole allowance either
	// side of the boundary and sustains double the configured rate.
	//
	// The fade is measured from the ROTATION, not from the original window: a
	// request that arrives after the window elapsed carries the old count over
	// whole and restarts the clock on it. So the boundary itself buys nothing at
	// all, and the allowance comes back gradually from there.
	const l = limiter();
	for (let i = 0; i < 10; i++) l.exceeded('203.0.113.7', 0);
	assert.equal(l.exceeded('203.0.113.7', 0), true, 'the allowance is spent');
	assert.equal(
		l.exceeded('203.0.113.7', 15_000),
		true,
		'and crossing the boundary does not refill it'
	);
	// Halfway through the window that rotation started, half the carried count
	// has faded: 10 * (1 - 0.5) = 5, so five are admitted and the sixth is not.
	let admitted = 0;
	for (let i = 0; i < 10; i++) {
		if (!l.exceeded('203.0.113.7', 20_000)) admitted++;
	}
	assert.equal(admitted, 5, 'half the carried window is still counted');
});

test('a client idle for two whole windows starts clean', () => {
	const l = limiter();
	for (let i = 0; i < 10; i++) l.exceeded('203.0.113.7', 0);
	assert.equal(l.exceeded('203.0.113.7', 25_000), false);
});

test('the entry cap evicts rather than refusing the newcomer', () => {
	// Refusing at the cap looks fail-closed and is the worse choice: one host
	// rotating identities fills every slot cheaply and every OTHER client is
	// then refused until the next sweep, turning a slow leak into an outage.
	let evicted = 0;
	const l = limiter({ maxEntries: 8, onEvict: () => { evicted++; } });
	for (let i = 0; i < 40; i++) l.exceeded(`203.0.113.${i}`, 1000);
	assert.equal(l.map.size, 8, 'the map stays at its cap');
	assert.ok(evicted > 0, 'and said so each time it dropped one');
	// The newcomer is admitted, which is the property being protected.
	assert.equal(l.exceeded('198.51.100.1', 1000), false);
});

test('a sweep drops what is idle and keeps what is not', () => {
	const l = limiter();
	l.exceeded('203.0.113.7', 0);
	l.exceeded('203.0.113.8', 19_000);
	l.sweep(25_000);
	assert.equal(l.map.has('203.0.113.7'), false, 'idle two whole windows');
	assert.equal(l.map.has('203.0.113.8'), true, 'still within them');
});

test('an unusable eviction sample still evicts', () => {
	// A sample of zero makes the inspection loop never run, so nothing is ever
	// evicted and the entry cap silently stops bounding the map - the guard's
	// own bound disabled by a knob. Not reachable from config; cheap to make
	// impossible.
	const l = limiter({ maxEntries: 4, evictionSample: 0 });
	for (let i = 0; i < 20; i++) l.exceeded(`203.0.113.${i}`, 1000);
	assert.equal(l.map.size, 4);
});

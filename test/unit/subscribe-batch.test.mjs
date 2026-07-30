import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyAllBatch, mapBatchDenials } from '../../src/runtime/utils/subscribe-batch.js';

test('a present key denies and an absent one allows', () => {
	const v = mapBatchDenials(['a', 'b', 'c'], { b: 'FORBIDDEN' });
	assert.equal(v.get('a'), null);
	assert.equal(v.get('b'), 'FORBIDDEN');
	assert.equal(v.get('c'), null);
});

test('every topic asked about gets an explicit answer', () => {
	// The trap: an absent key must map to null (allow), NOT undefined.
	// `undefined` reads downstream as "nothing decided" and falls back to the
	// per-topic `subscribe` gate an app exporting subscribeBatch did not write,
	// which would deny everything with SUBSCRIBE_NOT_CONFIGURED.
	const v = mapBatchDenials(['a', 'b'], {});
	assert.equal(v.size, 2);
	for (const topic of ['a', 'b']) {
		assert.ok(v.has(topic));
		assert.notEqual(v.get(topic), undefined, `${topic} must not be undefined`);
	}
});

test('undefined or null means allow everything', () => {
	// The documented "allow everything" returns.
	for (const ret of [undefined, null]) {
		const v = mapBatchDenials(['a'], ret);
		assert.equal(v.get('a'), null, `for ${JSON.stringify(ret)}`);
	}
});

test('a shape that cannot be read as a denials map fails CLOSED', () => {
	// A `Map` is the trap: the README says "return a map of topic -> denial
	// reason", so reaching for a real Map is a realistic mistake - and
	// `typeof map === 'object'` is true while hasOwnProperty finds nothing, so
	// every denial silently became an allow. This is the one shape in the file
	// that used to fail wide open with no signal at all.
	const shapes = [
		new Map([['a', 'FORBIDDEN']]),
		new Set(['a']),
		['a'],
		'nonsense',
		42
	];
	for (const ret of shapes) {
		const v = mapBatchDenials(['a'], ret);
		assert.equal(v.get('a'), 'INTERNAL_ERROR', `for ${String(ret)}`);
	}
});

test('a present key whose value is undefined does not read as "no verdict"', () => {
	// `denials[t] = REASONS[t]` on a lookup miss produces this, and `undefined`
	// downstream means "nothing decided" - which falls back to a per-topic gate
	// the app never wrote.
	const v = mapBatchDenials(['a', 'b'], { a: undefined, b: 'FORBIDDEN' });
	assert.equal(v.get('a'), null, 'an explicit allow, never undefined');
	assert.notEqual(v.get('a'), undefined);
	assert.equal(v.get('b'), 'FORBIDDEN');
});

test('a false value denies, matching the per-topic gate', () => {
	// normalizeSubscribeVerdict turns false into FORBIDDEN; the mapping just has
	// to carry it through rather than collapsing it to "absent".
	const v = mapBatchDenials(['a'], { a: false });
	assert.equal(v.get('a'), false);
});

test('own keys only, and a prototype-carrying object is not read at all', () => {
	// A null-prototype object is a plain map and IS read.
	const bare = Object.create(null);
	bare.a = 'FORBIDDEN';
	assert.equal(mapBatchDenials(['a'], bare).get('a'), 'FORBIDDEN');
	// One carrying an arbitrary prototype is not something we can read as a
	// denials map, so it fails closed rather than silently allowing whatever
	// happens to live on the prototype chain.
	const inherited = Object.create({ a: 'FORBIDDEN' });
	assert.equal(mapBatchDenials(['a'], inherited).get('a'), 'INTERNAL_ERROR');
	// A topic literally named like an Object.prototype member is still safe.
	assert.equal(mapBatchDenials(['hasOwnProperty'], {}).get('hasOwnProperty'), null);
});

test('an empty topic list produces an empty map', () => {
	assert.equal(mapBatchDenials([], { a: 'FORBIDDEN' }).size, 0);
});

test('denyAllBatch fails every topic closed', () => {
	const v = denyAllBatch(['a', 'b'], 'INTERNAL_ERROR');
	assert.equal(v.get('a'), 'INTERNAL_ERROR');
	assert.equal(v.get('b'), 'INTERNAL_ERROR');
});

test('a topic named __proto__ fails closed', () => {
	// `denials['__proto__'] = 'FORBIDDEN'` on an object literal hits
	// Object.prototype's accessor and creates no own key, so the denial would
	// read as absent = ALLOW. Indistinguishable from a hook that meant to allow
	// it, so it denies. Only reachable with allowSystemTopicSubscribe: true.
	const denials = {};
	denials['__proto__'] = 'FORBIDDEN';
	assert.equal(mapBatchDenials(['__proto__'], denials).get('__proto__'), 'INTERNAL_ERROR');
	assert.equal(mapBatchDenials(['__proto__'], {}).get('__proto__'), 'INTERNAL_ERROR');
	// Neighbouring topics are unaffected.
	assert.equal(mapBatchDenials(['__proto__', 'room'], { room: 'FORBIDDEN' }).get('room'), 'FORBIDDEN');
});

test('a verdict VALUE of the wrong type fails closed, not open', () => {
	// The container check above catches a Map or an array. This is the same
	// fail-wide-open one level down: downstream, anything that is not `false`
	// and not a string reads as ALLOW, so a value of the wrong TYPE let through
	// exactly the topic the hook was denying. The realistic shape is a forgotten
	// `await` - `denials[t] = db.denialFor(t)` stores a Promise.
	const unreadable = [
		Promise.resolve('FORBIDDEN'),
		403,
		new Error('FORBIDDEN'),
		{ reason: 'FORBIDDEN' },
		['FORBIDDEN'],
		Symbol('FORBIDDEN'),
		() => 'FORBIDDEN'
	];
	for (const value of unreadable) {
		const v = mapBatchDenials(['room'], { room: value });
		assert.equal(
			v.get('room'),
			'INTERNAL_ERROR',
			`${String(value)} must not read as an allow`
		);
	}
});

test('the four readable verdict shapes still mean what they document', () => {
	assert.equal(mapBatchDenials(['a'], { a: false }).get('a'), false, 'false denies');
	assert.equal(mapBatchDenials(['a'], { a: 'NOPE' }).get('a'), 'NOPE', 'a string denies');
	assert.equal(mapBatchDenials(['a'], { a: true }).get('a'), true, 'true allows');
	assert.equal(mapBatchDenials(['a'], { a: undefined }).get('a'), null, 'undefined allows');
	assert.equal(mapBatchDenials(['a'], { a: null }).get('a'), null, 'null allows');
});

test('one unreadable value does not condemn the rest of the batch', () => {
	const v = mapBatchDenials(['bad', 'good', 'denied'], {
		bad: 42,
		denied: 'FORBIDDEN'
	});
	assert.equal(v.get('bad'), 'INTERNAL_ERROR');
	assert.equal(v.get('good'), null);
	assert.equal(v.get('denied'), 'FORBIDDEN');
});

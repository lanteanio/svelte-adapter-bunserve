import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStaticResponse } from '../../src/runtime/utils/static-plan.js';

const ETAG = 'W/"abc-123"';
const SIZE = 1000;

// A mutable asset with both codings available, shaped as cacheDir bakes it.
// Frozen on purpose: entries live in the shared static cache, so anything that
// writes to one while serving a request is a bug. An early draft did exactly
// that; freezing turns a reintroduction into a failing test rather than a
// silent per-request write.
const asset = Object.freeze({
	etag: ETAG,
	brEtag: 'W/"abc-123-br"',
	gzEtag: 'W/"abc-123-gzip"',
	hasBr: true,
	hasGz: true
});

// An immutable versioned asset: no validator, so no conditionals and no ranges.
const immutable = Object.freeze({ etag: '', hasBr: true, hasGz: true });

/** plan(entry, {range, ifRange, ifNoneMatch, accept}) */
function plan(entry, o = {}) {
	return planStaticResponse(
		entry, SIZE, o.range || '', o.ifRange || '', o.ifNoneMatch || '', o.accept || ''
	);
}

test('plain request serves identity', () => {
	assert.deepEqual(plan(asset), { status: 200, encoding: '' });
});

test('negotiates brotli over gzip, and gzip when brotli is unavailable', () => {
	assert.deepEqual(plan(asset, { accept: 'gzip, deflate, br' }), { status: 200, encoding: 'br' });
	assert.deepEqual(
		plan({ ...asset, hasBr: false }, { accept: 'gzip, deflate, br' }),
		{ status: 200, encoding: 'gzip' }
	);
});

test('304 is evaluated against the representation the client would receive', () => {
	// identity validator, identity request
	assert.equal(plan(asset, { ifNoneMatch: ETAG }).status, 304);
	// coding validator, matching negotiated coding
	assert.equal(plan(asset, { ifNoneMatch: asset.brEtag, accept: 'br' }).status, 304);
});

test('a validator from a DIFFERENT representation never yields 304', () => {
	// This is the corruption guard: holding the identity validator must not
	// satisfy a request that would be answered with compressed bytes.
	assert.equal(plan(asset, { ifNoneMatch: ETAG, accept: 'br' }).status, 200);
	assert.equal(plan(asset, { ifNoneMatch: asset.brEtag }).status, 200);
	assert.equal(plan(asset, { ifNoneMatch: asset.gzEtag, accept: 'br' }).status, 200);
});

test('a served range pins identity and yields 206 with inclusive bounds', () => {
	assert.deepEqual(
		plan(asset, { range: 'bytes=0-9' }),
		{ status: 206, encoding: '', start: 0, end: 9 }
	);
	// even when the client would happily take brotli
	assert.deepEqual(
		plan(asset, { range: 'bytes=0-9', accept: 'br' }),
		{ status: 206, encoding: '', start: 0, end: 9 }
	);
});

test('an unusable Range header must NOT disable compression', () => {
	// The egress-amplification guard: a Range that cannot be served falls
	// through to a normal negotiated response, not to pinned identity.
	for (const range of ['bytes=x', 'bytes=1oops-5', 'bytes=0-9,20-29', 'bytes=abc']) {
		assert.deepEqual(
			plan(asset, { range, accept: 'gzip, deflate, br' }),
			{ status: 200, encoding: 'br' },
			`range ${range} should still negotiate`
		);
	}
});

test('a stale If-Range falls through to a negotiated full response', () => {
	assert.deepEqual(
		plan(asset, { range: 'bytes=0-9', ifRange: 'W/"stale"', accept: 'br' }),
		{ status: 200, encoding: 'br' }
	);
});

test('a matching If-Range honours the range', () => {
	assert.equal(plan(asset, { range: 'bytes=0-9', ifRange: ETAG }).status, 206);
});

test('unsatisfiable range yields 416 and stays identity', () => {
	assert.deepEqual(plan(asset, { range: 'bytes=5000-' }), { status: 416, encoding: '' });
});

test('If-None-Match takes precedence over an unsatisfiable range (RFC 7232)', () => {
	assert.equal(plan(asset, { range: 'bytes=5000-', ifNoneMatch: ETAG }).status, 304);
});

test('If-None-Match takes precedence over a servable range', () => {
	assert.equal(plan(asset, { range: 'bytes=0-9', ifNoneMatch: ETAG }).status, 304);
});

test('a honoured range compares If-None-Match against the identity validator', () => {
	// The range pins identity, so a client holding a coding validator gets no
	// 304 - it does not hold the representation being served.
	assert.equal(plan(asset, { range: 'bytes=0-9', ifNoneMatch: asset.brEtag }).status, 206);
});

test('immutable assets never range and never 304, but still negotiate', () => {
	assert.deepEqual(plan(immutable, { range: 'bytes=0-9' }), { status: 200, encoding: '' });
	assert.deepEqual(plan(immutable, { ifNoneMatch: 'W/"anything"' }), { status: 200, encoding: '' });
	assert.deepEqual(plan(immutable, { accept: 'br' }), { status: 200, encoding: 'br' });
});

test('an asset with no precompressed variants always serves identity', () => {
	const plainAsset = { etag: ETAG };
	assert.deepEqual(plan(plainAsset, { accept: 'gzip, deflate, br' }), { status: 200, encoding: '' });
});

test('the plan never selects a coding the entry does not advertise', () => {
	// Guards the contract serveStatic relies on when it indexes brHeaders /
	// gzHeaders without a null check.
	const cases = [
		{ ...asset, hasBr: false, hasGz: false },
		{ ...asset, hasBr: true, hasGz: false },
		{ ...asset, hasBr: false, hasGz: true }
	];
	for (const entry of cases) {
		for (const accept of ['br', 'gzip', 'gzip, deflate, br', '']) {
			const p = plan(entry, { accept });
			if (p.encoding === 'br') assert.ok(entry.hasBr, 'br only when advertised');
			if (p.encoding === 'gzip') assert.ok(entry.hasGz, 'gzip only when advertised');
		}
	}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStaticResponse } from '../../src/runtime/utils/static-plan.js';

const ETAG = 'W/"abc-123"';
const SIZE = 1000;

// A mutable asset with both codings available, shaped as cacheDir bakes it.
// Frozen on purpose: entries live in the shared static cache, so anything that
// writes to one while serving a request is a bug. Freezing catches any
// per-request writes.
const asset = Object.freeze({
	etag: ETAG,
	brEtag: 'W/"abc-123-br"',
	gzEtag: 'W/"abc-123-gzip"',
	hasBr: true,
	brSize: 100,
	gzSize: 200,
	hasGz: true
});

// An immutable versioned asset: wildcard conditions still test existence.
const immutable = Object.freeze({ etag: '', hasBr: true, hasGz: true });

test('immutable entries evaluate preconditions without matching empty validators', () => {
	assert.equal(plan(immutable, { ifMatch: '"missing"', ifNoneMatch: '*' }).status, 412);
	assert.equal(plan(immutable, { ifMatch: '*' }).status, 200);
	assert.equal(plan(immutable, { ifMatch: '*', ifNoneMatch: '*' }).status, 304);
	assert.equal(plan(immutable, { ifMatch: ', "missing"' }).status, 412);
	assert.equal(plan(immutable, { ifNoneMatch: ', "missing"' }).status, 200);
	assert.equal(plan(immutable, { ifModifiedSince: 'Sun, 06 Nov 1994 08:49:37 GMT' }).status, 200);
});

/** plan(entry, {range, ifRange, ifNoneMatch, accept, ifMatch, ifUnmodifiedSince, ifModifiedSince}) */
function plan(entry, o = {}) {
	return planStaticResponse(
		entry, SIZE, o.range || '', o.ifRange || '', o.ifNoneMatch || '', o.accept || '',
		o.ifMatch || '', o.ifUnmodifiedSince || '', o.ifModifiedSince || ''
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

test('a served range uses the negotiated representation', () => {
	assert.deepEqual(
		plan(asset, { range: 'bytes=0-9' }),
		{ status: 206, encoding: '', start: 0, end: 9 }
	);
	// Coded ranges keep the negotiated representation.
	assert.deepEqual(
		plan(asset, { range: 'bytes=0-9', accept: 'br' }),
		{ status: 206, encoding: 'br', start: 0, end: 9 }
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

test('a weak If-Range never authorizes a range', () => {
	assert.equal(plan(asset, { range: 'bytes=0-9', ifRange: ETAG }).status, 200);
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
	// Without Accept-Encoding this request selects identity, so a coding validator gets no
	// 304 - it does not hold the representation being served.
	assert.equal(plan(asset, { range: 'bytes=0-9', ifNoneMatch: asset.brEtag }).status, 206);
});

test('immutable assets never range or match specific tags, but still negotiate', () => {
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

// --- the RFC 9110 preconditions -------------------------------------------
//
// A fixed mtime keeps every date computable by eye: the file changed at
// t = 1_700_000_000 (Tue, 14 Nov 2023 22:13:20 GMT).
const MTIME = 1_700_000_000;
const dated = Object.freeze({ ...asset, mtimeSec: MTIME, lastModified: new Date(MTIME * 1000).toUTCString() });
const BEFORE = new Date((MTIME - 100) * 1000).toUTCString();
const AT = new Date(MTIME * 1000).toUTCString();
const AFTER = new Date((MTIME + 100) * 1000).toUTCString();

test('If-Match with a stale validator answers 412, not a fresh body', () => {
	assert.deepEqual(plan(dated, { ifMatch: 'W/"old-etag"' }), { status: 412, encoding: '' });
});

test('If-Match accepts any validator issued for the asset', () => {
	for (const accept of ['', 'br', 'gzip']) {
		for (const ifMatch of [ETAG, dated.brEtag, dated.gzEtag, '*', `W/"other", ${ETAG}`]) {
			assert.equal(plan(dated, { ifMatch, accept }).status, 200);
		}
	}
});

test('If-None-Match takes the wildcard and the list form', () => {
	assert.equal(plan(dated, { ifNoneMatch: '*' }).status, 304);
	assert.equal(plan(dated, { ifNoneMatch: `W/"other", ${ETAG}` }).status, 304);
	assert.equal(plan(dated, { ifNoneMatch: 'W/"one", W/"two"' }).status, 200);
	// Per coding, like every other conditional here.
	assert.equal(plan(dated, { ifNoneMatch: `W/"other", ${dated.brEtag}`, accept: 'br' }).status, 304);
	assert.equal(plan(dated, { ifNoneMatch: `W/"other", ${ETAG}`, accept: 'br' }).status, 200);
});

test('If-None-Match compares weakly while If-Match requires an issued tag', () => {
	assert.equal(plan(dated, { ifNoneMatch: '"abc-123"' }).status, 304);
	assert.equal(plan(dated, { ifMatch: '"abc-123"' }).status, 412);
});

test('weak lists walk quoted tags, reject malformed prefixes and preserve representation selection', () => {
	for (const [accept, tag] of [['', dated.etag], ['br', dated.brEtag], ['gzip', dated.gzEtag]]) {
		const opaque = tag.slice(2);
		for (const header of [tag, opaque, `"other", ${opaque}`, `W/"other,tag",\t${opaque}`, `, \t${tag},`, ` ${opaque} `]) {
			assert.equal(plan(dated, { accept, ifNoneMatch: header }).status, 304, `${accept}: ${header}`);
		}
		for (const header of [`other, ${opaque}`, `W/other, ${opaque}`, `w/${opaque}`, `"other" junk, ${opaque}`, `"unterminated, ${opaque}`, '"other,tag"']) {
			assert.equal(plan(dated, { accept, ifNoneMatch: header }).status, 200, `${accept}: ${header}`);
		}
	}
	assert.equal(plan(dated, { accept: 'br', ifNoneMatch: dated.etag.slice(2) }).status, 200);
	assert.equal(plan({ ...dated, etag: '"strong"' }, { ifNoneMatch: 'W/"strong"' }).status, 304);
	assert.equal(plan({ ...dated, etag: 'W/"comma,tag"' }, { ifNoneMatch: '"other", "comma,tag"' }).status, 304);
});

test('a 304 carries the coding that was negotiated, not identity', () => {
	// The caller reads this to pick which baked validator the 304 announces.
	assert.deepEqual(plan(dated, { ifNoneMatch: dated.brEtag, accept: 'br' }),
		{ status: 304, encoding: 'br' });
	assert.deepEqual(plan(dated, { ifModifiedSince: AT, accept: 'gzip' }),
		{ status: 304, encoding: 'gzip' });
});

test('date preconditions ignore non-HTTP dates', () => {
	assert.equal(plan(dated, { ifModifiedSince: '2023-11-14T22:13:20Z' }).status, 200);
	assert.equal(plan(dated, { ifModifiedSince: '14 Nov 2023' }).status, 200);
	assert.equal(plan(dated, { ifUnmodifiedSince: '2000-01-01' }).status, 200);
	assert.equal(plan(dated, { ifModifiedSince: 'Tuesday, 14-Nov-23 22:13:20 GMT' }).status, 304);
	assert.equal(plan(dated, { ifModifiedSince: 'Tue Nov 14 22:13:20 2023' }).status, 304);
	assert.equal(plan(dated, { ifModifiedSince: 'Tue Nov 14 22:13:20 2023 GMT' }).status, 200);
});

test('a failed If-Match wins over a matching If-None-Match', () => {
	// RFC 9110 evaluation order: the client asked "is my version current" and
	// the answer is no - a 304 would claim freshness the validator denied.
	assert.equal(plan(dated, { ifMatch: 'W/"old"', ifNoneMatch: ETAG }).status, 412);
});

test('If-Unmodified-Since answers 412 only for a file modified after the date', () => {
	assert.deepEqual(plan(dated, { ifUnmodifiedSince: BEFORE }), { status: 412, encoding: '' });
	assert.equal(plan(dated, { ifUnmodifiedSince: AT }).status, 200);
	assert.equal(plan(dated, { ifUnmodifiedSince: AFTER }).status, 200);
});

test('If-Match present means If-Unmodified-Since is not evaluated', () => {
	// RFC 9110 s13.2.2: the validator precondition owns the decision when both
	// are sent.
	assert.equal(plan(dated, { ifMatch: ETAG, ifUnmodifiedSince: BEFORE }).status, 200);
});

test('If-Modified-Since answers 304 for an unchanged file', () => {
	assert.deepEqual(plan(dated, { ifModifiedSince: AT }), { status: 304, encoding: '' });
	assert.deepEqual(plan(dated, { ifModifiedSince: AFTER }), { status: 304, encoding: '' });
	assert.equal(plan(dated, { ifModifiedSince: BEFORE }).status, 200);
});

test('If-None-Match present means If-Modified-Since is ignored', () => {
	// A date-based 304 after an etag MISmatch would claim freshness the
	// validator just denied.
	assert.equal(plan(dated, { ifNoneMatch: 'W/"other"', ifModifiedSince: AFTER }).status, 200);
});

test('an unparseable date is an ignored header, never a refusal', () => {
	assert.equal(plan(dated, { ifUnmodifiedSince: 'not a date' }).status, 200);
	assert.equal(plan(dated, { ifModifiedSince: 'not a date' }).status, 200);
});

test('an entry with no recorded mtime answers no date precondition', () => {
	// The immutable lane and any entry built before the mtime was captured:
	// date preconditions fall through to a full response rather than guessing.
	assert.equal(plan(asset, { ifUnmodifiedSince: BEFORE }).status, 200);
	assert.equal(plan(asset, { ifModifiedSince: AFTER }).status, 200);
});

test('a 412 outranks a satisfiable range', () => {
	assert.equal(plan(dated, { ifMatch: 'W/"old"', range: 'bytes=0-99' }).status, 412);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The HTTP response twin of io-budget.test.mjs: OPERATION COUNTS per response,
// never timings, because a wall-clock assertion cannot gate CI. The static
// lane's whole design is "everything expensive happened at index time" - one
// Map lookup, one Headers, one Response per request - and these gates are what
// keep that true. The counters wrap the late-bound globals the lane actually
// calls (Response, Headers, Bun.file, decodeURIComponent), so a regression
// that adds a per-request disk touch, an extra header build, or a lost cache
// shows up as a changed COUNT under 6x load, deterministically.
//
// EVERY BRANCH THAT ANSWERS A REQUEST IS DRIVEN HERE, not just the happy one.
// A budget only gates the branches the test actually executes, and the
// branches that go unexercised are exactly where a per-response cost creeps
// in unnoticed: the compressed representations (which is what a real browser
// negotiates), the disk lane past the identity GET, ranges, HEAD, the
// canonical-form redirect, and the malformed-path refusal.
//
// NOT covered, honestly, and the boundary is exact: this file measures what
// `serveStatic` and `tryPrerendered` cost. It does NOT cover per-response
// socket writes - Bun.serve owns the transmit path, the adapter hands it a
// Response and never touches the socket, so there is no seam to count through
// - and it does not cover the dispatch above these two functions, where
// server.js builds one `new URL(req.url)` per request. That URL is a real
// per-request cost on a countable global; it is simply not in this lane.
//
// One further limit on the disk numbers: `Bun.file` is stubbed here, so what
// is counted is CALL ARITY, not file handles. Real Bun.file is lazy and opens
// nothing until the body is read, so "one Bun.file per GET" gates the code
// path rather than measuring the syscall.
//
// Lowering a budget needs no discussion. RAISING one is a design decision -
// it says a response now costs more I/O - so record the reason in the comment
// on that budget, in the same change that raises it.

globalThis.PRECOMPRESS = true;
globalThis.STATIC_CACHE_MAX = 1024;
globalThis.STATIC_DOTFILES = false;
globalThis.ENV_PREFIX = '';

register('../helpers/manifest-loader.mjs', import.meta.url);

const counts = { response: 0, headers: 0, bunFile: 0, decode: 0 };

const RealResponse = globalThis.Response;
const RealHeaders = globalThis.Headers;
const realDecode = globalThis.decodeURIComponent;
globalThis.Response = class extends RealResponse {
	/** @param {any[]} args */
	constructor(...args) {
		counts.response++;
		super(...args);
	}
};
globalThis.Headers = class extends RealHeaders {
	/** @param {any[]} args */
	constructor(...args) {
		counts.headers++;
		super(...args);
	}
};
globalThis.decodeURIComponent = (s) => {
	counts.decode++;
	return realDecode(s);
};
// The overflow lane hands Bun.file's return straight to Response as the body,
// and a range slices it first; a string is a valid BodyInit under Node and
// answers .slice, so the count is taken and the Response still constructs.
globalThis.Bun = {
	file: () => {
		counts.bunFile++;
		return 'FAKE-FILE-BODY';
	}
};

const { cacheDir, serveStatic, tryPrerendered, DECODE_CACHE_MAX } = await import(
	'../../src/runtime/handler/static-assets.js'
);
const { staticCache, decodeCache } = await import('../../src/runtime/handler/state.js');
const { prerendered } = await import('../../src/runtime/manifest-bridge.js');

// A scratch asset tree. Both lanes carry smaller .br/.gz variants, so
// negotiation is real on each: without them the disk lane can only ever be
// exercised as an identity GET, and its compressed arms - the ones a browser
// actually reaches - are dead to every budget below.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-http-budget-'));
fs.writeFileSync(path.join(dir, 'small.js'), 'x'.repeat(400));
fs.writeFileSync(path.join(dir, 'small.js.br'), 'b'.repeat(80));
fs.writeFileSync(path.join(dir, 'small.js.gz'), 'g'.repeat(120));
fs.writeFileSync(path.join(dir, 'big.bin'), 'y'.repeat(4096));
fs.writeFileSync(path.join(dir, 'big.bin.br'), 'b'.repeat(500));
fs.writeFileSync(path.join(dir, 'big.bin.gz'), 'g'.repeat(800));
// A directory-style prerendered page, so the canonical-form redirect and the
// serve-the-trailing-slash-form branch are reachable.
fs.mkdirSync(path.join(dir, 'docs'));
fs.writeFileSync(path.join(dir, 'docs', 'index.html'), '<h1>docs</h1>');
cacheDir(dir, '', false, null);
prerendered.add('/docs');
const small = /** @type {any} */ (staticCache.get('/small.js'));
const big = /** @type {any} */ (staticCache.get('/big.bin'));
assert.ok(small && big, 'the scratch assets indexed');
assert.ok(small.hasBr && small.hasGz, 'the memory lane negotiates both codings');
assert.ok(big.hasBr && big.hasGz, 'and so does the disk lane');
assert.ok(big.file && !big.buffer, 'big.bin took the disk lane');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Run fn and return what it cost, as count deltas.
 * @param {() => void} fn
 */
function cost(fn) {
	const before = { ...counts };
	fn();
	return {
		response: counts.response - before.response,
		headers: counts.headers - before.headers,
		bunFile: counts.bunFile - before.bunFile,
		decode: counts.decode - before.decode
	};
}

/**
 * The same call six times over, as one measurement. Every budget is stated
 * this way rather than once: a single call cannot tell a fixed cost from one
 * that grows, and growth is the regression these gates exist to catch.
 *
 * @param {() => void} fn
 */
function costOfSix(fn) {
	return cost(() => {
		for (let i = 0; i < 6; i++) fn();
	});
}

/**
 * @param {{ response: number, headers: number, bunFile: number, decode: number }} per
 */
const times6 = (per) => ({
	response: per.response * 6,
	headers: per.headers * 6,
	bunFile: per.bunFile * 6,
	decode: per.decode * 6
});

// Header objects are built OUTSIDE every measured closure. A `new Headers()`
// inside one is counted as though the runtime had built it, which silently
// inflates that budget by one and makes it unpinnable.
const NO_HEADERS = new Headers();
const ACCEPT = {
	br: new Headers({ 'accept-encoding': 'br' }),
	gzip: new Headers({ 'accept-encoding': 'gzip' }),
	// A real browser sends a list. It negotiates to br, so this is the same
	// branch as `br` above rather than a fourth one - asserted to pin the
	// choice, not counted as separate coverage.
	list: new Headers({ 'accept-encoding': 'gzip, br' })
};
const RANGE = new Headers({ range: 'bytes=0-9' });
const UNSATISFIABLE_RANGE = new Headers({ range: 'bytes=9999-' });
const CONDITIONAL = new Headers({ 'if-none-match': /** @type {string} */ (small.etag) });

test('a cached asset costs one Headers and one Response, and 6x costs exactly 6x', () => {
	// headers: 1 is the single entryHeaders build from the tuples baked at
	// index time - the "single Headers construction" the static lane's
	// design comments promise. The Response constructor contributes zero
	// global Headers constructions - a property of undici's INTERNAL Headers
	// class, not of this codebase, so a Node upgrade could shift that term
	// of the count. If this gate ever fails with headers off by a constant
	// per Response across every test here, suspect undici first.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(small, NO_HEADERS)), per);
	assert.deepEqual(
		costOfSix(() => serveStatic(small, NO_HEADERS)),
		times6(per),
		'6x the requests must not change the per-request count of anything'
	);
});

test('every memory-lane representation costs one Headers, one Response and no disk', () => {
	// The compressed arms are what a browser actually gets, and they build
	// their headers from a DIFFERENT precomputed tuple list than identity -
	// so a per-request build added there is invisible to the identity budget
	// above.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	for (const [name, accept] of [['identity', NO_HEADERS], ['br', ACCEPT.br], ['gzip', ACCEPT.gzip]]) {
		assert.deepEqual(cost(() => serveStatic(small, /** @type {Headers} */ (accept))), per, name);
		assert.deepEqual(costOfSix(() => serveStatic(small, /** @type {Headers} */ (accept))), times6(per), name);
	}
	// A coding LIST resolves to br - the same branch, stated so the loop above
	// is not read as covering four distinct representations.
	const listed = /** @type {any} */ (serveStatic(small, ACCEPT.list));
	assert.equal(listed.headers.get('content-encoding'), 'br');
});

test('the disk lane costs exactly one Bun.file per GET, on every representation', () => {
	const per = { response: 1, headers: 1, bunFile: 1, decode: 0 };
	for (const [name, accept] of [['identity', NO_HEADERS], ['br', ACCEPT.br], ['gzip', ACCEPT.gzip]]) {
		assert.deepEqual(cost(() => serveStatic(big, /** @type {Headers} */ (accept))), per, name);
		assert.deepEqual(
			costOfSix(() => serveStatic(big, /** @type {Headers} */ (accept))),
			times6(per),
			`${name}: one file handle per request, no growth`
		);
	}
});

test('a HEAD answers from the index alone, on both lanes', () => {
	// The body source is never opened: that is the whole claim of a HEAD, and
	// it is the one place where "the same headers as a GET" could quietly be
	// paid for with a disk touch.
	const diskHead = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(big, NO_HEADERS, true)), diskHead);
	assert.deepEqual(costOfSix(() => serveStatic(big, NO_HEADERS, true)), times6(diskHead));

	const memoryHead = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(small, NO_HEADERS, true)), memoryHead);
	assert.deepEqual(costOfSix(() => serveStatic(small, NO_HEADERS, true)), times6(memoryHead));
});

test('a 304 costs one Response and no header build at all', () => {
	const per = { response: 1, headers: 0, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(small, CONDITIONAL)), per);
	assert.deepEqual(costOfSix(() => serveStatic(small, CONDITIONAL)), times6(per));
});

test('a memory-lane range is one Headers, one Response and zero disk', () => {
	// The 206 path builds its headers from the identity tuples and then sets
	// content-range on the SAME object - one build, not two.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(small, RANGE)), per, 'a buffer range is a subarray');
	assert.deepEqual(cost(() => serveStatic(small, RANGE, true)), per, 'and a HEAD of one costs the same');
	assert.deepEqual(costOfSix(() => serveStatic(small, RANGE)), times6(per));
});

test('a disk-lane range slices the file once', () => {
	const per = { response: 1, headers: 1, bunFile: 1, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(big, RANGE)), per);
	assert.deepEqual(costOfSix(() => serveStatic(big, RANGE)), times6(per));
	// A HEAD of a range states the length instead of producing bytes, so the
	// file is not opened at all.
	assert.deepEqual(cost(() => serveStatic(big, RANGE, true)), { response: 1, headers: 1, bunFile: 0, decode: 0 });
});

test('an unsatisfiable range costs one Response and builds no headers', () => {
	const per = { response: 1, headers: 0, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => serveStatic(small, UNSATISFIABLE_RANGE)), per);
	assert.deepEqual(costOfSix(() => serveStatic(small, UNSATISFIABLE_RANGE)), times6(per));
});

test('the canonical-form redirect and the page it points at cost one Response each', () => {
	const redirect = { response: 1, headers: 0, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => tryPrerendered('/docs', '', NO_HEADERS)), redirect);
	assert.deepEqual(costOfSix(() => tryPrerendered('/docs', '', NO_HEADERS)), times6(redirect));

	const served = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => tryPrerendered('/docs/', '', NO_HEADERS)), served);
});

test('a malformed encoded path decodes once and refuses', () => {
	// The failed decode is not memoized as a hit that skips the decode - it is
	// memoized as null - so a repeat costs no second decode and still refuses.
	decodeCache.clear();
	const first = cost(() => tryPrerendered('/%E0%A4%A', '', NO_HEADERS));
	assert.deepEqual(first, { response: 1, headers: 0, bunFile: 0, decode: 1 });
	assert.deepEqual(
		costOfSix(() => tryPrerendered('/%E0%A4%A', '', NO_HEADERS)),
		{ response: 6, headers: 0, bunFile: 0, decode: 0 },
		'a refused path is remembered, not re-decoded'
	);
});

test('a path with no percent-encoding never decodes at all', () => {
	// The fast path in decodePath, and the branch that carries essentially all
	// real traffic. Without this gate the whole decode budget is stated only
	// for encoded paths: deleting the fast path would cost a decode AND a
	// cache insert per distinct plain path, and every other test here would
	// still pass because every other test hands in an encoded one.
	decodeCache.clear();
	const plain = costOfSix(() => tryPrerendered('/plain/path/here', '', NO_HEADERS));
	assert.equal(plain.decode, 0, 'an unencoded path must not reach decodeURIComponent');
	const distinct = cost(() => {
		for (let i = 0; i < 6; i++) tryPrerendered(`/plain/${i}`, '', NO_HEADERS);
	});
	assert.equal(distinct.decode, 0, 'and neither must six distinct ones');
	assert.equal(decodeCache.size, 0, 'nor may they consume the decode cache');
});

test('repeated encoded paths cost one decode; the cache is doing its job', () => {
	// The cache is module-global, so this clears it rather than relying on
	// having run before whatever else touches the same path.
	decodeCache.clear();
	const one = cost(() => tryPrerendered('/caf%C3%A9', '', NO_HEADERS));
	assert.equal(one.decode, 1, 'the first sighting decodes');
	assert.equal(costOfSix(() => tryPrerendered('/caf%C3%A9', '', NO_HEADERS)).decode, 0,
		'6x the same path must not decode again');
});

test('the decode cache is bounded, and an evicted path decodes again', () => {
	// The bound is what keeps a flood of distinct encoded paths from growing
	// the cache without limit. Nothing else in the suite reaches it, so
	// removing the eviction is otherwise invisible.
	decodeCache.clear();
	for (let i = 0; i < DECODE_CACHE_MAX; i++) tryPrerendered(`/fill-%2F${i}`, '', NO_HEADERS);
	assert.equal(decodeCache.size, DECODE_CACHE_MAX, 'the cache filled to exactly the cap');
	const overflow = cost(() => tryPrerendered('/overflow-%2F', '', NO_HEADERS));
	assert.equal(overflow.decode, 1);
	assert.ok(decodeCache.size <= DECODE_CACHE_MAX, `cache grew past the cap: ${decodeCache.size}`);
	// The oldest entry was the one evicted, so it pays for a decode again.
	assert.equal(cost(() => tryPrerendered('/fill-%2F0', '', NO_HEADERS)).decode, 1);
	decodeCache.clear();
});

test('SELF-CHECK: the detector sees work that genuinely scales', () => {
	// Six DISTINCT encoded paths must cost six decodes - if this passes with
	// fewer, the counter is broken and every gate above is vacuous.
	decodeCache.clear();
	const six = cost(() => {
		for (let i = 0; i < 6; i++) tryPrerendered(`/self-check-%2${i}`, '', NO_HEADERS);
	});
	assert.equal(six.decode, 6);
	// And the response counter: six real serves are six Responses.
	assert.equal(costOfSix(() => serveStatic(small, NO_HEADERS)).response, 6);
});

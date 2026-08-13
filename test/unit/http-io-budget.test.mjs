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
// shows up as a changed COUNT under load, deterministically.
//
// EVERY BRANCH THAT ANSWERS A REQUEST IS DRIVEN HERE, not just the happy one.
// A budget only gates the branches the test actually executes, and the
// branches that go unexercised are exactly where a per-response cost creeps
// in unnoticed: the compressed representations (which is what a real browser
// negotiates), the disk lane past the identity GET, ranges, HEAD, the
// canonical-form redirect, and the malformed-path refusal.
//
// AND THE COUNT IS NOT THE ONLY THING ASSERTED. A budget of one Headers and
// one Response says nothing about WHICH representation came back, so the
// nastiest bugs in this lane - serving identity bytes under a
// `content-encoding: br` header, or handing a HEAD the whole body - are
// invisible to a counter. Each representation is therefore checked for its
// own bytes and its own status beside its budget.
//
// WHAT IS NOT COVERED, and the boundary is exact:
//   - Only four globals are counted: Response, Headers, Bun.file and
//     decodeURIComponent. Any other per-request allocation - an array rebuilt
//     inside entryHeaders, say - is free as far as these numbers go, and so is
//     the Map lookup the opening line of this comment promises.
//   - Per-response socket writes. Bun.serve owns the transmit path: the
//     adapter hands it a Response and never touches the socket, so there is no
//     seam to count through.
//   - The dispatch ABOVE these two functions. server.js builds one
//     `new URL(req.url)` per request, including every static-cache hit. That
//     is a real per-request cost on a countable global; it is simply not in
//     this lane.
//   - Bun.file is stubbed here, so the disk numbers are CALL ARITY, not file
//     handles: real Bun.file is lazy and opens nothing until the body is read.
//     The stub does record its ARGUMENT, so which file a representation chose
//     is asserted even though the handle is not real.
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
/** Every path handed to Bun.file, in order. */
const opened = [];

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
// The path is recorded because the COUNT cannot tell br from identity: a disk
// lane that ignored negotiation would open the wrong file the right number of
// times.
globalThis.Bun = {
	/** @param {string} p */
	file: (p) => {
		counts.bunFile++;
		opened.push(String(p));
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
// actually reaches - are dead to every budget below. Each file's bytes are
// distinct so the representation that came back is identifiable from the body
// alone.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-http-budget-'));
const IDENTITY_BODY = 'x'.repeat(400);
const BR_BODY = 'b'.repeat(80);
const GZ_BODY = 'g'.repeat(120);
fs.writeFileSync(path.join(dir, 'small.js'), IDENTITY_BODY);
fs.writeFileSync(path.join(dir, 'small.js.br'), BR_BODY);
fs.writeFileSync(path.join(dir, 'small.js.gz'), GZ_BODY);
fs.writeFileSync(path.join(dir, 'big.bin'), 'y'.repeat(4096));
fs.writeFileSync(path.join(dir, 'big.bin.br'), 'b'.repeat(500));
fs.writeFileSync(path.join(dir, 'big.bin.gz'), 'g'.repeat(800));
// Two directory-style prerendered pages: a small one for the canonical-form
// redirect and its target, and one past the cache cap so the prerendered
// lane's HEAD is measured on the DISK lane, where a body it should not have
// produced costs a file open.
fs.mkdirSync(path.join(dir, 'docs'));
fs.writeFileSync(path.join(dir, 'docs', 'index.html'), '<h1>docs</h1>');
fs.mkdirSync(path.join(dir, 'bigdocs'));
fs.writeFileSync(path.join(dir, 'bigdocs', 'index.html'), '<p>' + 'd'.repeat(2000) + '</p>');
cacheDir(dir, '', false, null);
prerendered.add('/docs');
prerendered.add('/bigdocs');
const small = /** @type {any} */ (staticCache.get('/small.js'));
const big = /** @type {any} */ (staticCache.get('/big.bin'));
assert.ok(small && big, 'the scratch assets indexed');
assert.ok(small.hasBr && small.hasGz, 'the memory lane negotiates both codings');
assert.ok(big.hasBr && big.hasGz, 'and so does the disk lane');
assert.ok(big.file && !big.buffer, 'big.bin took the disk lane');
assert.ok(/** @type {any} */ (staticCache.get('/bigdocs/'))?.file, 'the big prerendered page took the disk lane');
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
 * How many times a budget is measured. Every budget that CAN be stated at
 * scale is, because a single call cannot tell a fixed cost from one that
 * grows. The exceptions are all one shape: a FIRST decode is measured once,
 * because a first sighting happens once. There are four - a malformed path, a
 * fresh path, the fresh path that overflows the cache, and the evicted entry
 * that must decode again - and each is a first sighting of a path this cache
 * does not hold. Repeating one would measure the cached path instead, which is
 * the separate claim the scaled decode budgets make.
 *
 * The number is large deliberately. A window of six only catches growth with a
 * period of six or less: a disk touch taken every 64th request, or a second
 * header build once an entry has been served forty times, is exactly the shape
 * a cache or a pool regression takes, and it hides completely inside a short
 * window. Two hundred is past any amortization period a per-response cache
 * would plausibly use and still costs milliseconds.
 */
const SCALE = 200;

/**
 * @param {(i: number) => void} fn
 */
function costAtScale(fn) {
	return cost(() => {
		for (let i = 0; i < SCALE; i++) fn(i);
	});
}

/**
 * @param {{ response: number, headers: number, bunFile: number, decode: number }} per
 */
const scaled = (per) => ({
	response: per.response * SCALE,
	headers: per.headers * SCALE,
	bunFile: per.bunFile * SCALE,
	decode: per.decode * SCALE
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

test('a cached asset costs one Headers and one Response, and load does not change that', () => {
	// headers: 1 is the single entryHeaders build from the tuples baked at
	// index time - the "single Headers construction" the static lane's
	// design comments promise. The Response constructor contributes zero
	// global Headers constructions - a property of undici's INTERNAL Headers
	// class, not of this codebase, so a Node upgrade could shift that term
	// of the count. If this gate ever fails with headers off by a constant
	// per Response across every test here, suspect undici first.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	/** @type {any} */
	let res;
	assert.deepEqual(cost(() => { res = serveStatic(small, NO_HEADERS); }), per);
	assert.equal(res.status, 200);
	assert.deepEqual(
		costAtScale(() => serveStatic(small, NO_HEADERS)),
		scaled(per),
		'the per-request count of everything must be flat under load'
	);
});

test('every memory-lane representation costs one Headers, one Response and no disk', async () => {
	// The compressed arms are what a browser actually gets, and they build
	// their headers from a DIFFERENT precomputed tuple list than identity -
	// so a per-request build added there is invisible to the identity budget
	// above. The BODY is asserted beside the count because a budget cannot
	// see the worst bug this lane has: identity bytes under a compressed
	// content-encoding, which every client would decode into garbage.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	const cases = [
		['identity', NO_HEADERS, '', IDENTITY_BODY],
		['br', ACCEPT.br, 'br', BR_BODY],
		['gzip', ACCEPT.gzip, 'gzip', GZ_BODY]
	];
	for (const [name, accept, encoding, body] of cases) {
		/** @type {any} */
		let res;
		assert.deepEqual(cost(() => { res = serveStatic(small, /** @type {any} */ (accept)); }), per, name);
		assert.equal(res.status, 200, name);
		assert.equal(res.headers.get('content-encoding'), encoding || null, `${name}: content-encoding`);
		assert.equal(await res.text(), body, `${name}: the bytes of that representation`);
		assert.deepEqual(costAtScale(() => serveStatic(small, /** @type {any} */ (accept))), scaled(per), name);
	}
	// A coding LIST resolves to br - the same branch, stated so the loop above
	// is not read as covering four distinct representations.
	assert.equal(serveStatic(small, ACCEPT.list).headers.get('content-encoding'), 'br');
});

test('the disk lane costs one Bun.file per GET and opens the negotiated file', async () => {
	// Which file was opened is the assertion the count cannot make: a disk
	// lane that ignored negotiation would open the identity file exactly once
	// per request and satisfy every budget here while serving br headers over
	// uncompressed bytes.
	const per = { response: 1, headers: 1, bunFile: 1, decode: 0 };
	const cases = [
		['identity', NO_HEADERS, '', 'big.bin'],
		['br', ACCEPT.br, 'br', 'big.bin.br'],
		['gzip', ACCEPT.gzip, 'gzip', 'big.bin.gz']
	];
	for (const [name, accept, encoding, file] of cases) {
		opened.length = 0;
		/** @type {any} */
		let res;
		assert.deepEqual(cost(() => { res = serveStatic(big, /** @type {any} */ (accept)); }), per, name);
		assert.equal(res.status, 200, name);
		assert.equal(res.headers.get('content-encoding'), encoding || null, `${name}: content-encoding`);
		assert.deepEqual(opened, [path.join(dir, /** @type {string} */ (file))], `${name}: opened file`);
		assert.deepEqual(costAtScale(() => serveStatic(big, /** @type {any} */ (accept))), scaled(per), name);
	}
});

test('a HEAD answers from the index alone, on both lanes and on the prerendered lane', async () => {
	// The body source is never opened, and no body comes back: that is the
	// whole claim of a HEAD, and a count alone cannot see the second half.
	// Content-Length still has to describe the body a GET would have sent.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };

	/** @type {any} */
	let diskHead;
	opened.length = 0;
	assert.deepEqual(cost(() => { diskHead = serveStatic(big, NO_HEADERS, true); }), per);
	assert.equal(diskHead.body, null, 'a disk-lane HEAD carries no body');
	assert.equal(diskHead.headers.get('content-length'), '4096');
	assert.deepEqual(opened, [], 'and opened nothing');
	assert.deepEqual(costAtScale(() => serveStatic(big, NO_HEADERS, true)), scaled(per));

	/** @type {any} */
	let memoryHead;
	assert.deepEqual(cost(() => { memoryHead = serveStatic(small, NO_HEADERS, true); }), per);
	assert.equal(memoryHead.body, null, 'a memory-lane HEAD carries no body');
	assert.equal(memoryHead.headers.get('content-length'), String(IDENTITY_BODY.length));
	assert.deepEqual(costAtScale(() => serveStatic(small, NO_HEADERS, true)), scaled(per));

	// Per REPRESENTATION, because that is what a browser HEADs and it is the
	// half a count cannot see: a HEAD that answers content-encoding: br with
	// the identity length tells a client sizing a download exactly the wrong
	// number, and every budget above is satisfied while it does.
	const headLengths = [
		['memory br', small, ACCEPT.br, 'br', BR_BODY.length],
		['memory gzip', small, ACCEPT.gzip, 'gzip', GZ_BODY.length],
		['disk identity', big, NO_HEADERS, '', 4096],
		['disk br', big, ACCEPT.br, 'br', 500],
		['disk gzip', big, ACCEPT.gzip, 'gzip', 800]
	];
	for (const [name, entry, accept, encoding, length] of headLengths) {
		/** @type {any} */
		let res;
		opened.length = 0;
		assert.deepEqual(cost(() => { res = serveStatic(entry, /** @type {any} */ (accept), true); }), per, name);
		assert.equal(res.body, null, `${name}: no body`);
		assert.equal(res.headers.get('content-encoding'), encoding || null, `${name}: content-encoding`);
		assert.equal(res.headers.get('content-length'), String(length),
			`${name}: the length of the representation it says it is sending`);
		assert.deepEqual(opened, [], `${name}: opened nothing`);
		opened.length = 0;
		assert.deepEqual(
			costAtScale(() => serveStatic(entry, /** @type {any} */ (accept), true)),
			scaled(per),
			`${name}: under load`
		);
		assert.deepEqual(opened, [], `${name}: and opened nothing under load either`);
	}

	// The prerendered lane takes the same headOnly flag through a second
	// function, on a page big enough to be served from disk - so a HEAD that
	// produced a body would show up as a file open here.
	/** @type {any} */
	let pageHead;
	opened.length = 0;
	assert.deepEqual(cost(() => { pageHead = tryPrerendered('/bigdocs/', '', NO_HEADERS, true); }), per);
	assert.equal(pageHead.status, 200);
	assert.equal(pageHead.body, null, 'a prerendered HEAD carries no body');
	assert.deepEqual(opened, [], 'and opened nothing');
	opened.length = 0;
	assert.deepEqual(costAtScale(() => tryPrerendered('/bigdocs/', '', NO_HEADERS, true)), scaled(per), 'under load');
	assert.deepEqual(opened, [], 'nor under load');
});

test('a 304 costs one Response and no header build at all', () => {
	const per = { response: 1, headers: 0, bunFile: 0, decode: 0 };
	/** @type {any} */
	let res;
	assert.deepEqual(cost(() => { res = serveStatic(small, CONDITIONAL); }), per);
	assert.equal(res.status, 304);
	assert.deepEqual(costAtScale(() => serveStatic(small, CONDITIONAL)), scaled(per));
});

test('a memory-lane range is one Headers, one Response and zero disk', async () => {
	// The 206 path builds its headers from the identity tuples and then sets
	// content-range on the SAME object - one build, not two.
	const per = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	/** @type {any} */
	let res;
	assert.deepEqual(cost(() => { res = serveStatic(small, RANGE); }), per, 'a buffer range is a subarray');
	assert.equal(res.status, 206);
	assert.equal(res.headers.get('content-range'), `bytes 0-9/${IDENTITY_BODY.length}`);
	assert.equal(await res.text(), IDENTITY_BODY.slice(0, 10));
	/** @type {any} */
	let head;
	assert.deepEqual(cost(() => { head = serveStatic(small, RANGE, true); }), per, 'and a HEAD of one costs the same');
	assert.equal(head.body, null);
	assert.equal(head.headers.get('content-length'), '10');
	assert.deepEqual(costAtScale(() => serveStatic(small, RANGE)), scaled(per));
	assert.deepEqual(costAtScale(() => serveStatic(small, RANGE, true)), scaled(per), 'the HEAD too');
});

test('a disk-lane range slices the identity file once', async () => {
	const per = { response: 1, headers: 1, bunFile: 1, decode: 0 };
	/** @type {any} */
	let res;
	opened.length = 0;
	assert.deepEqual(cost(() => { res = serveStatic(big, RANGE); }), per);
	assert.equal(res.status, 206);
	assert.equal(res.headers.get('content-range'), 'bytes 0-9/4096');
	// The requested ten bytes, not nine and not the whole file. The stub's
	// body is a string, so the slice the disk lane takes is observable here
	// exactly as the memory lane's subarray is.
	assert.equal(await res.text(), 'FAKE-FILE-');
	// Ranges are served from the identity representation only, whatever the
	// request would otherwise have negotiated.
	assert.deepEqual(opened, [path.join(dir, 'big.bin')]);
	assert.deepEqual(costAtScale(() => serveStatic(big, RANGE)), scaled(per));
	// A HEAD of a range states the length instead of producing bytes, so the
	// file is not opened at all.
	opened.length = 0;
	/** @type {any} */
	let head;
	// One less Bun.file than the GET above: the length comes from the index.
	const perHead = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	assert.deepEqual(cost(() => { head = serveStatic(big, RANGE, true); }), perHead);
	assert.equal(head.body, null);
	assert.equal(head.headers.get('content-length'), '10');
	assert.equal(head.headers.get('content-range'), 'bytes 0-9/4096');
	assert.deepEqual(opened, []);
	assert.deepEqual(costAtScale(() => serveStatic(big, RANGE, true)), scaled(perHead), 'the HEAD too');
	assert.deepEqual(opened, [], 'and it opened nothing under load either');
});

test('an unsatisfiable range costs one Response and builds no headers', () => {
	const per = { response: 1, headers: 0, bunFile: 0, decode: 0 };
	/** @type {any} */
	let res;
	assert.deepEqual(cost(() => { res = serveStatic(small, UNSATISFIABLE_RANGE); }), per);
	assert.equal(res.status, 416);
	assert.equal(res.headers.get('content-range'), `bytes */${IDENTITY_BODY.length}`);
	assert.deepEqual(costAtScale(() => serveStatic(small, UNSATISFIABLE_RANGE)), scaled(per));
});

test('the canonical-form redirect and the page it points at cost one Response each', () => {
	const redirect = { response: 1, headers: 0, bunFile: 0, decode: 0 };
	/** @type {any} */
	let res;
	assert.deepEqual(cost(() => { res = tryPrerendered('/docs', '', NO_HEADERS); }), redirect);
	assert.equal(res.status, 308);
	assert.equal(res.headers.get('location'), '/docs/');
	assert.deepEqual(costAtScale(() => tryPrerendered('/docs', '', NO_HEADERS)), scaled(redirect));

	const served = { response: 1, headers: 1, bunFile: 0, decode: 0 };
	/** @type {any} */
	let page;
	assert.deepEqual(cost(() => { page = tryPrerendered('/docs/', '', NO_HEADERS); }), served);
	assert.equal(page.status, 200);
	assert.deepEqual(costAtScale(() => tryPrerendered('/docs/', '', NO_HEADERS)), scaled(served));
});

test('a malformed encoded path decodes once and refuses', () => {
	// The failed decode is not memoized as a hit that skips the decode - it is
	// memoized as null - so a repeat costs no second decode and still refuses.
	decodeCache.clear();
	/** @type {any} */
	let res;
	assert.deepEqual(
		cost(() => { res = tryPrerendered('/%E0%A4%A', '', NO_HEADERS); }),
		{ response: 1, headers: 0, bunFile: 0, decode: 1 }
	);
	assert.equal(res.status, 400);
	assert.deepEqual(
		costAtScale(() => tryPrerendered('/%E0%A4%A', '', NO_HEADERS)),
		{ response: SCALE, headers: 0, bunFile: 0, decode: 0 },
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
	assert.equal(costAtScale(() => tryPrerendered('/plain/path/here', '', NO_HEADERS)).decode, 0,
		'an unencoded path must not reach decodeURIComponent');
	assert.equal(costAtScale((i) => tryPrerendered(`/plain/${i}`, '', NO_HEADERS)).decode, 0,
		'and neither must distinct ones');
	assert.equal(decodeCache.size, 0, 'nor may they consume the decode cache');
});

test('repeated encoded paths cost one decode; the cache is doing its job', () => {
	// The cache is module-global, so this clears it rather than relying on
	// having run before whatever else touches the same path.
	decodeCache.clear();
	const one = cost(() => tryPrerendered('/caf%C3%A9', '', NO_HEADERS));
	assert.equal(one.decode, 1, 'the first sighting decodes');
	assert.equal(costAtScale(() => tryPrerendered('/caf%C3%A9', '', NO_HEADERS)).decode, 0,
		'the same path under load must not decode again');
});

test('the decode cache is bounded at 256, and an evicted path decodes again', () => {
	// The bound is what keeps a flood of distinct encoded paths from growing
	// the cache without limit. The literal is pinned rather than compared
	// against the constant it is measuring: a cache of one entry, or of two
	// hundred thousand, would satisfy "size === DECODE_CACHE_MAX" and neither
	// is the bound this lane means.
	assert.equal(DECODE_CACHE_MAX, 256, 'raising this is a memory decision, so state it here too');
	decodeCache.clear();
	for (let i = 0; i < 256; i++) tryPrerendered(`/fill-%2F${i}`, '', NO_HEADERS);
	assert.equal(decodeCache.size, 256, 'the cache filled to exactly the cap');
	assert.equal(cost(() => tryPrerendered('/overflow-%2F', '', NO_HEADERS)).decode, 1);
	assert.equal(decodeCache.size, 256, 'and stayed there');
	// The oldest entry was the one evicted, so it pays for a decode again.
	assert.equal(cost(() => tryPrerendered('/fill-%2F0', '', NO_HEADERS)).decode, 1);
	decodeCache.clear();
});

test('SELF-CHECK: the detector sees work that genuinely scales', () => {
	// Distinct encoded paths must cost one decode each - if this passes with
	// fewer, the counter is broken and every gate above is vacuous. Kept under
	// the decode cache's own bound so eviction is not what produces the count.
	decodeCache.clear();
	const distinct = cost(() => {
		for (let i = 0; i < 200; i++) tryPrerendered(`/self-check-%2F${i}`, '', NO_HEADERS);
	});
	assert.equal(distinct.decode, 200);
	// And the response counter: real serves are real Responses.
	assert.equal(costAtScale(() => serveStatic(small, NO_HEADERS)).response, SCALE);
	decodeCache.clear();
});

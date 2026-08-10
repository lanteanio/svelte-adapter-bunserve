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
// NOT covered, honestly: per-response socket writes. Bun.serve owns the
// transmit path - the adapter hands it a Response and never touches the
// socket - so there is no seam to count writes through. The countable seams
// above are everything the adapter's own code contributes per response.
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
// The overflow lane hands Bun.file's return straight to Response as the body;
// a string is a valid BodyInit under Node, so the count is taken and the
// Response still constructs.
globalThis.Bun = {
	file: () => {
		counts.bunFile++;
		return 'FAKE-FILE-BODY';
	}
};

const { cacheDir, serveStatic, tryPrerendered } = await import(
	'../../src/runtime/handler/static-assets.js'
);
const { staticCache } = await import('../../src/runtime/handler/state.js');

// A scratch asset tree: one cacheable file (with smaller .br/.gz variants so
// negotiation is real), and one file over the 1024-byte cap so it takes the
// disk lane. Indexed once - cacheDir cost is boot cost, not per-request cost.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunserve-http-budget-'));
fs.writeFileSync(path.join(dir, 'small.js'), 'x'.repeat(400));
fs.writeFileSync(path.join(dir, 'small.js.br'), 'b'.repeat(80));
fs.writeFileSync(path.join(dir, 'small.js.gz'), 'g'.repeat(120));
fs.writeFileSync(path.join(dir, 'big.bin'), 'y'.repeat(4096));
cacheDir(dir, '', false, null);
const small = /** @type {any} */ (staticCache.get('/small.js'));
const big = /** @type {any} */ (staticCache.get('/big.bin'));
assert.ok(small && big, 'the scratch assets indexed');
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

const NO_HEADERS = new Headers();

test('a cached asset costs one Headers and one Response, and 6x costs exactly 6x', () => {
	// headers: 1 is the single entryHeaders build from the tuples baked at
	// index time - the "single Headers construction" the static lane's
	// design comments promise. The Response constructor contributes zero
	// global Headers constructions - a property of undici's INTERNAL Headers
	// class, not of this codebase, so a Node upgrade could shift that term
	// of the count. If this gate ever fails with headers off by a constant
	// per Response across every test here, suspect undici first.
	const one = cost(() => serveStatic(small, NO_HEADERS));
	assert.deepEqual(one, { response: 1, headers: 1, bunFile: 0, decode: 0 });
	const six = cost(() => {
		for (let i = 0; i < 6; i++) serveStatic(small, NO_HEADERS);
	});
	assert.deepEqual(
		six,
		{ response: 6, headers: 6, bunFile: 0, decode: 0 },
		'6x the requests must not change the per-request count of anything'
	);
});

test('a memory-lane asset never touches the disk, on any representation', () => {
	for (const accept of ['', 'br', 'gzip, br', 'gzip']) {
		const h = new Headers(accept ? { 'accept-encoding': accept } : {});
		const c = cost(() => serveStatic(small, h));
		assert.equal(c.bunFile, 0, `accept-encoding: "${accept}" cost a disk read`);
		assert.equal(c.response, 1);
	}
});

test('the disk lane costs exactly one Bun.file per GET, and zero per HEAD', () => {
	const get = cost(() => serveStatic(big, NO_HEADERS));
	assert.deepEqual(get, { response: 1, headers: 1, bunFile: 1, decode: 0 });
	const six = cost(() => {
		for (let i = 0; i < 6; i++) serveStatic(big, NO_HEADERS);
	});
	assert.equal(six.bunFile, 6, 'one file handle per request, no growth');
	const head = cost(() => serveStatic(big, NO_HEADERS, true));
	assert.deepEqual(
		head,
		{ response: 1, headers: 1, bunFile: 0, decode: 0 },
		'a HEAD answers from the index alone - the body source is never opened'
	);
});

test('a 304 costs one Response and no header build at all', () => {
	const conditional = new Headers({ 'if-none-match': /** @type {string} */ (small.etag) });
	const c = cost(() => serveStatic(small, conditional));
	assert.deepEqual(c, { response: 1, headers: 0, bunFile: 0, decode: 0 });
});

test('a range from the memory lane is served zero-disk, one Response', () => {
	const c = cost(() => serveStatic(small, new Headers({ range: 'bytes=0-9' })));
	assert.equal(c.response, 1);
	assert.equal(c.bunFile, 0, 'a buffer range is a subarray, never a file read');
});

test('repeated encoded paths cost one decode; the cache is doing its job', () => {
	const one = cost(() => tryPrerendered('/caf%C3%A9', '', NO_HEADERS));
	assert.equal(one.decode, 1, 'the first sighting decodes');
	const six = cost(() => {
		for (let i = 0; i < 6; i++) tryPrerendered('/caf%C3%A9', '', NO_HEADERS);
	});
	assert.equal(six.decode, 0, '6x the same path must not decode again');
});

test('SELF-CHECK: the detector sees work that genuinely scales', () => {
	// Six DISTINCT encoded paths must cost six decodes - if this passes with
	// fewer, the counter is broken and every gate above is vacuous.
	const six = cost(() => {
		for (let i = 0; i < 6; i++) tryPrerendered(`/self-check-%2${i}`, '', NO_HEADERS);
	});
	assert.equal(six.decode, 6);
	// And the response counter: six real serves are six Responses.
	const serves = cost(() => {
		for (let i = 0; i < 6; i++) serveStatic(small, NO_HEADERS);
	});
	assert.equal(serves.response, 6);
});

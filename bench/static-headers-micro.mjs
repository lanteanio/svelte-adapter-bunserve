// Per-request cost of answering a static asset request, BEFORE the
// representation-ETag work vs what actually ships now.
//
// The NEW arm runs the whole shipped per-request path - planStaticResponse
// (range resolution, negotiation, validator selection) plus the single Headers
// construction - not just the cheap half, so the number describes production
// rather than flattering it.
//
// The correctness work (a distinct validator per content coding, no
// accept-ranges on an encoded response) must not be paid for per request: it
// is resolved at index time, so serving any representation costs one Headers
// construction.
//
// Run under BUN, not Node: Headers is a different implementation on each, and
// only Bun's is the one production pays for. Arms are interleaved and reported
// as min-of-N, because this box has large run-to-run variance.
//
// usage: bun bench/static-headers-micro.mjs

import { planStaticResponse } from '../src/runtime/utils/static-plan.js';
import { representationEtag } from '../src/runtime/utils/static-negotiate.js';

const ETAG = 'W/"ms0s2o64.qu-15g"';
const CONTENT_TYPE = 'text/plain';
const SIZE = 1492;

// OLD: content-type written per request, coding applied per request, one
// shared validator across every representation.
const oldBase = [
	['x-content-type-options', 'nosniff'],
	['vary', 'Accept-Encoding'],
	['accept-ranges', 'bytes'],
	['cache-control', 'no-cache'],
	['etag', ETAG]
];

function oldPath(acceptEncoding, ifNoneMatch) {
	if (ifNoneMatch === ETAG) return null;
	const headers = new Headers(oldBase);
	headers.set('content-type', CONTENT_TYPE);
	if (acceptEncoding.includes('br')) headers.set('content-encoding', 'br');
	else if (acceptEncoding.includes('gzip')) headers.set('content-encoding', 'gzip');
	return headers;
}

// NEW: everything resolvable is resolved at index time; the request runs the
// plan and picks a tuple array.
const identityTuples = [
	['content-type', CONTENT_TYPE],
	['x-content-type-options', 'nosniff'],
	['vary', 'Accept-Encoding'],
	['accept-ranges', 'bytes'],
	['cache-control', 'no-cache'],
	['etag', ETAG]
];

// Mirrors variantHeaders() in src/runtime/handler/static-assets.js. The
// duplication is unavoidable - that module carries build-time placeholders and
// cannot be imported here - so if you change one, change the other.
function variantTuples(base, encoding) {
	const out = [];
	for (const [key, value] of base) {
		if (key === 'accept-ranges') continue;
		if (key === 'etag') { out.push(['etag', representationEtag(ETAG, encoding)]); continue; }
		out.push([key, value]);
	}
	out.push(['content-encoding', encoding]);
	return out;
}

const entry = {
	etag: ETAG,
	brEtag: representationEtag(ETAG, 'br'),
	gzEtag: representationEtag(ETAG, 'gzip'),
	hasBr: true,
	hasGz: true
};
const brTuples = variantTuples(identityTuples, 'br');
const gzTuples = variantTuples(identityTuples, 'gzip');

function newPath(acceptEncoding, ifNoneMatch) {
	const plan = planStaticResponse(entry, SIZE, '', '', ifNoneMatch, acceptEncoding);
	if (plan.status === 304) return null;
	if (plan.encoding === 'br') return new Headers(brTuples);
	if (plan.encoding === 'gzip') return new Headers(gzTuples);
	return new Headers(identityTuples);
}

function timeOnce(fn, accept, inm, iters) {
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < iters; i++) fn(accept, inm);
	return Number(process.hrtime.bigint() - t0) / iters;
}

const ITERS = 200000;
const ROUNDS = 7;

for (const [label, accept, inm] of [
	['identity', '', ''],
	['negotiated (br)', 'gzip, deflate, br', ''],
	['304 (identity)', '', ETAG]
]) {
	// Warm both arms before timing either.
	for (let i = 0; i < 50000; i++) { oldPath(accept, inm); newPath(accept, inm); }

	let oldBest = Infinity;
	let newBest = Infinity;
	for (let round = 0; round < ROUNDS; round++) {
		// Interleaved, so drift during the run hits both arms alike.
		oldBest = Math.min(oldBest, timeOnce(oldPath, accept, inm, ITERS));
		newBest = Math.min(newBest, timeOnce(newPath, accept, inm, ITERS));
	}
	const delta = ((newBest - oldBest) / oldBest) * 100;
	console.log(
		`${label.padEnd(17)} old ${oldBest.toFixed(1)} ns/op | new ${newBest.toFixed(1)} ns/op | ` +
		`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%   (min of ${ROUNDS})`
	);
}

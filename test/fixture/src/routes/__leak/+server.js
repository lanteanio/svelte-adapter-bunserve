// The leak lane's window into the server it is driving, and nothing else.
//
// Reading a process's resident set from OUTSIDE means asking the operating
// system, which spells the answer differently on every platform and reports a
// number the runtime itself never sees. Asking the process is exact and
// portable, and it is the only way to force a collection at a chosen instant -
// which the lane needs, because a baseline taken before the heap has settled
// invents a leak out of the climb back to the working set.
//
// ARMED BY ENVIRONMENT, and unreachable otherwise. Without `LEAK_PROBE` every
// operation here answers 404, the same as a route that does not exist. That is
// not a formality: `op=gc` is a synchronous full collection on request, which
// is a denial-of-service primitive if it can ever be reached, and "it is only
// in the test fixture" is not a boundary the build enforces. The environment
// variable is. The lane sets it on the server it spawns and nothing else does.
//
// This lives in the FIXTURE rather than in the adapter deliberately: the
// adapter has no business shipping a memory endpoint, gated or otherwise, and
// a fixture route cannot reach a user's build.
//
// `op=retain` is the self-check's planted leak. It exists so the lane can
// prove it still detects one; a lane that has quietly lost that ability
// otherwise reports a clean bill of health, which is worse than no lane.
//
// The operations and their answers are the svelte-adapter-uws fixture's, so
// one lane's probe calls read the other's server unchanged.

/** Retained on purpose by `op=retain`, released by `op=release`. */
const retained = [];

/** @param {number} status @param {unknown} body */
function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

export function GET({ url, platform }) {
	if (process.env.LEAK_PROBE !== '1') return new Response('Not Found', { status: 404 });

	const op = url.searchParams.get('op');

	if (op === 'mem') {
		const usage = process.memoryUsage();
		return json(200, {
			rss: usage.rss,
			heapUsed: usage.heapUsed,
			heapTotal: usage.heapTotal,
			external: usage.external,
			retained: retained.length,
			// The live WebSocket count, which is a leak signal RSS cannot give: a
			// close path that fails to release leaves connections registered
			// while the allocator quietly reuses their pages, so memory looks
			// flat.
			//
			// Deliberately NOT process._getActiveHandles(): on Bun it returns an
			// empty array even with a live server bound, so a harness reporting
			// it would print a reassuring 0 that means nothing at all.
			connections: platform?.connections ?? -1
		});
	}

	if (op === 'gc') {
		// Bun exposes a synchronous full collection unconditionally; the flag
		// V8 needs for the same thing is honoured too, for a runtime that only
		// offers the global. Reported rather than thrown when neither is there:
		// the lane decides whether an unforced baseline is worth continuing
		// with, and it cannot decide that if the probe simply fails.
		if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
			Bun.gc(true);
			return json(200, { collected: true });
		}
		const gc = /** @type {undefined | (() => void)} */ (globalThis.gc);
		if (typeof gc !== 'function') return json(200, { collected: false, reason: 'gc-not-exposed' });
		gc();
		return json(200, { collected: true });
	}

	if (op === 'retain') {
		// Bounded both ways: a negative or zero size is not a smaller leak, it
		// is an allocation that throws, and a 500 here would read as the
		// server breaking under the self-check rather than as bad input. Absent
		// or unreadable means the default; zero and below mean the smallest.
		const asked = Number(url.searchParams.get('kb') ?? 64);
		const kb = Math.min(Math.max(Number.isFinite(asked) ? asked : 64, 1), 1024);
		// Filled rather than allocated empty: an untouched Buffer.alloc is
		// zero-page-backed on some platforms and may never appear in the
		// resident set, which would make the planted leak invisible and the
		// self-check a lie in the reassuring direction.
		retained.push(Buffer.alloc(kb * 1024, 0x5a));
		return json(200, { retained: retained.length });
	}

	if (op === 'release') {
		const freed = retained.length;
		retained.length = 0;
		return json(200, { freed });
	}

	return json(400, { error: 'unknown op', accepts: ['mem', 'gc', 'retain', 'release'] });
}

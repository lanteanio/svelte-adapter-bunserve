import { json } from '@sveltejs/kit';

// The leak harness's memory probe, and its readiness hook: one route that
// answers "what does this process weigh right now".
//
// ENV-GATED, and that is not a formality. A route that forces a collection on
// request is a denial-of-service primitive - Bun.gc(true) is a synchronous
// full collection, so an open one lets anybody stall the event loop at will.
// It exists only when LEAK_PROBE is set, which the harness sets on the server
// it spawns and nothing else does.
//
// This lives in the FIXTURE rather than in the adapter deliberately. The
// adapter has no business shipping a memory endpoint, gated or otherwise, and
// a fixture route cannot reach a user's build.

const ARMED = process.env.LEAK_PROBE === '1';

/**
 * `?gc=1` forces a full collection first, which is what makes a BASELINE
 * comparable to a FINAL reading: without it the two differ by whatever the
 * collector happened not to have run yet, and that noise is the same order as
 * the growth being looked for. It is deliberately not the default - collecting
 * on every 2s sample would flatten the very curve the slope is measuring, and
 * turn a real leak into a sawtooth that trends nowhere.
 */
export function GET({ url, platform }) {
	if (!ARMED) return new Response('not armed', { status: 404 });
	if (url.searchParams.get('gc') === '1' && typeof Bun !== 'undefined') Bun.gc(true);
	const m = process.memoryUsage();
	return json({
		rss: m.rss,
		heapUsed: m.heapUsed,
		heapTotal: m.heapTotal,
		external: m.external,
		// The live WebSocket count, which is a leak signal RSS cannot give: a
		// close path that fails to release leaves connections registered while
		// the allocator quietly reuses their pages, so memory looks flat.
		//
		// Deliberately NOT process._getActiveHandles(): on Bun it returns an
		// empty array even with a live server bound, so a harness reporting it
		// would print a reassuring 0 that means nothing at all.
		connections: platform?.connections ?? -1,
		uptimeMs: Math.round(process.uptime() * 1000)
	});
}

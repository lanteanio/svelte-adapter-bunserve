// One fixture, three build-time adapters: the ADAPTER env var picks which
// production build `vite build` produces, so SSR/static A/B benchmarks compare
// the SAME app across svelte-adapter-bunserve (Bun), svelte-adapter-uws
// (Node), and @sveltejs/adapter-node run under Bun.
//
// svelte-adapter-uws is NOT a dependency: ADAPTER=uws imports it by path from
// a sibling checkout, overridable with UWS_ADAPTER. Declaring it as one made
// `npm install` here fail outright on any clone without that sibling three
// levels up, which took the whole live test lane - the thing that defends the
// wire contract - with it.
import bunserve from 'svelte-adapter-bunserve';

const which = process.env.ADAPTER || 'bunserve';

// Compared against the values that MEAN yes, not tested for truthiness: every
// environment variable is a string, so `NO_WS=0` set to turn this off would
// turn it on.
const noWs = process.env.NO_WS === '1' || process.env.NO_WS === 'true';

let adapter;
if (which === 'bunserve' && noWs) {
	// The no-handler regression build for test/live/no-ws-check.mjs: no
	// websocket options, and websocketHandler pointed at a file the fixture
	// does not have. That is the same no-handler state as an app that never
	// opted into the realtime tier, without touching src/ws-handler.js.
	adapter = bunserve({ out: 'build-no-ws', websocketHandler: 'src/no-ws-handler.js' });
} else if (which === 'bunserve') {
	// A deliberately small subscription cap so the live smoke tests can prove the
	// bound actually holds. At the 10,000 default a cap regression is invisible:
	// no test would ever reach it.
	adapter = bunserve({ out: 'build', websocket: { maxSubscriptionsPerConnection: 20 } });
} else if (which === 'node') {
	const node = (await import('@sveltejs/adapter-node')).default;
	adapter = node({ out: 'build-node' });
} else if (which === 'uws') {
	const from = process.env.UWS_ADAPTER || '../../../svelte-adapter-uws/src/index.js';
	const uws = (await import(from)).default;
	adapter = uws({ out: 'build-uws' });
} else {
	throw new Error(`unknown ADAPTER "${which}" (have: bunserve, node, uws)`);
}

export default {
	kit: { adapter }
};

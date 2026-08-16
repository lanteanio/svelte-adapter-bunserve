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
const dotfiles = process.env.STATIC_DOTFILES === '1' || process.env.STATIC_DOTFILES === 'true';
const admission = process.env.WS_ADMISSION === '1' || process.env.WS_ADMISSION === 'true';
const upgradeTimeout = process.env.WS_UPGRADE_TIMEOUT === '1' || process.env.WS_UPGRADE_TIMEOUT === 'true';
const rateLimit = process.env.WS_RATE_LIMIT === '1' || process.env.WS_RATE_LIMIT === 'true';

let adapter;
if (which === 'bunserve' && dotfiles) {
	// The opted-in build for test/live/static-dotfiles-check.mjs. Serving
	// refuses dot-segment paths by default, so proving the escape hatch works
	// takes a second build of the same static/ tree with the option on.
	adapter = bunserve({ out: 'build-dotfiles', staticDotfiles: true });
} else if (which === 'bunserve' && noWs) {
	// The no-handler regression build for test/live/no-ws-check.mjs:
	// `websocket.handler` points at a file the fixture does not have. That is
	// the same no-handler state as an app that never opted into the realtime
	// tier, without touching src/ws-handler.js.
	adapter = bunserve({ out: 'build-no-ws', websocket: { handler: 'src/no-ws-handler.js' } });
} else if (which === 'bunserve' && admission) {
	// The admission build for test/live/admission-check.mjs. A ceiling of TWO,
	// which is the whole point: the default is unlimited, so a gate regression
	// is invisible unless some build sets a bound low enough for a test to
	// actually reach. It cannot go in the main build - the leak lane churns
	// connections at 50 rps against that one, and a ceiling of two would shed
	// most of them.
	adapter = bunserve({
		out: 'build-admission',
		websocket: { upgradeAdmission: { maxConnections: 2 } }
	});
} else if (which === 'bunserve' && rateLimit) {
	// The build for test/live/upgrade-rate-limit-check.mjs. Three per ten
	// seconds, low enough for a test to reach without waiting - the default of
	// ten would need eleven handshakes to prove anything, and the main build has
	// the limiter off because every other suite drives it from one address.
	adapter = bunserve({
		out: 'build-rate-limit',
		websocket: { upgradeRateLimit: 3, upgradeRateLimitWindow: 10 }
	});
} else if (which === 'bunserve' && upgradeTimeout) {
	// The build for test/live/upgrade-timeout-check.mjs. Its own, because the
	// admission build's suite hangs a handshake open for four seconds on
	// purpose, and any bound short enough to be reached by a test would answer
	// that handshake before it could be abandoned.
	//
	// A ceiling as well as a bound: what a timeout has to GIVE BACK is the half
	// worth proving over a real socket, and there is nothing to give back on a
	// server with no ceiling.
	adapter = bunserve({
		out: 'build-upgrade-timeout',
		websocket: { upgradeTimeout: 0.3, upgradeAdmission: { maxConnections: 2 } }
	});
} else if (which === 'bunserve') {
	// A deliberately small subscription cap so the live smoke tests can prove the
	// bound actually holds. At the 10,000 default a cap regression is invisible:
	// no test would ever reach it.
	adapter = bunserve({
		out: 'build',
		websocket: {
			// OFF. Every suite and the leak lane drive this build from one
			// address - the leak lane at 50 rps for minutes - which is precisely
			// the traffic shape the per-address limit exists to refuse. Left at
			// its default the lane measures the limiter instead of memory: 240 of
			// 250 warmup requests refused, a 98% error rate, and a verdict that
			// cannot vouch for anything. A test harness on one machine is one
			// client by this measure, which is a real property worth knowing
			// rather than a quirk of the fixture. The limit gets its own build
			// (WS_RATE_LIMIT) where it is the subject.
			upgradeRateLimit: 0,
			maxSubscriptionsPerConnection: 20,
			// A NON-DEFAULT pressure block, so the live suite proves the whole
			// round trip - normalize, serialize into the build, read back at
			// boot, resolve into the sampler - and not just its two ends. The
			// faster interval also lets that suite watch several real samples
			// without sleeping for seconds.
			pressure: { sampleIntervalMs: 200 }
		}
	});
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

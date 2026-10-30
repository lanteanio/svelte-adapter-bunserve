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
import bunserve from '../../src/index.js';
import { websocketOptions } from './websocket-options.mjs';

const which = process.env.ADAPTER || 'bunserve';

// Compared against the values that MEAN yes, not tested for truthiness: every
// environment variable is a string, so `NO_WS=0` set to turn this off would
// turn it on.
const noWs = process.env.NO_WS === '1' || process.env.NO_WS === 'true';
const dotfiles = process.env.STATIC_DOTFILES === '1' || process.env.STATIC_DOTFILES === 'true';
const admission = process.env.WS_ADMISSION === '1' || process.env.WS_ADMISSION === 'true';
const upgradeTimeout = process.env.WS_UPGRADE_TIMEOUT === '1' || process.env.WS_UPGRADE_TIMEOUT === 'true';
const rateLimit = process.env.WS_RATE_LIMIT === '1' || process.env.WS_RATE_LIMIT === 'true';
const backpressure = process.env.WS_BACKPRESSURE === '1' || process.env.WS_BACKPRESSURE === 'true';
const warmupHang = process.env.WARMUP_HANG === '1' || process.env.WARMUP_HANG === 'true';
const mountSpelling = process.env.MOUNT_SPELLING === '1' || process.env.MOUNT_SPELLING === 'true';

let adapter;
if (which === 'bunserve' && dotfiles) {
	// The opted-in build for test/live/static-dotfiles-check.mjs. Serving
	// refuses dot-segment paths by default, so proving the escape hatch works
	// takes a second build of the same static/ tree with the option on.
	adapter = bunserve({ out: 'build-dotfiles', staticDotfiles: true });
} else if (which === 'bunserve' && noWs) {
	// Disable realtime explicitly even though src/hooks.ws.js exists and the
	// Vite plugin is installed, as proved by test/live/no-ws-check.mjs.
	adapter = bunserve({ out: 'build-no-ws', websocket: false });
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
	// Both metered doors, each low enough for a test to reach and each with its
	// own suite. They are deliberately the SAME number here: the property worth
	// proving live is that the budgets are separate, and two doors that agree on
	// the number make a shared-map regression show up as a refusal that arrives
	// far too early rather than as an off-by-one nobody notices.
	adapter = bunserve({
		out: 'build-rate-limit',
		websocket: {
			upgradeRateLimit: 3,
			upgradeRateLimitWindow: 10,
			authPathRateLimit: 3,
			authPathRateLimitWindow: 10
		}
	});
} else if (which === 'bunserve' && warmupHang) {
	// The build for test/live/warmup-check.mjs. Its warmup points at a route
	// whose body never ends, which is the one shape that could hang readiness:
	// draining it would await forever, behind a render nobody is asking for.
	// The warmup has to cancel the body instead and commit readiness anyway.
	// Its own build - every other suite would pay that render at boot.
	adapter = bunserve({
		out: 'build-warmup-hang',
		warmup: { paths: ['/warmup-hang'] }
	});
} else if (which === 'bunserve' && mountSpelling) {
	// The build for test/live/mount-spelling-check.mjs: probes spelled with an
	// escape and with router syntax inside a segment, for the guard that keeps
	// other spellings of a mounted path out of the app.
	adapter = bunserve({
		out: 'build-mount-spelling',
		healthCheckPath: '/gesundheit-pr%C3%BCfung',
		readinessCheckPath: '/status:ready',
		websocket: false
	});
} else if (which === 'bunserve' && backpressure) {
	// The build for test/live/resume-backpressure-check.mjs. A backpressure
	// limit small enough that a resume flush can actually fill it, which is the
	// only way to reach the branch where the truncation marker itself is
	// refused and the connection is closed instead of acked. The default is a
	// megabyte, and no test is going to push a megabyte through every other
	// suite's server to get there.
	adapter = bunserve({
		out: 'build-backpressure',
		websocket: { maxBackpressure: 64 * 1024 }
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
	adapter = bunserve({
		out: process.env.FIXTURE_BASE_PATH ? 'build-base' : 'build',
		envPrefix: process.env.FIXTURE_ENV_PREFIX || '',
		staticCacheControl: [{ pattern: '/test.txt', cacheControl: 'public, max-age=600' }],
		staticHeaders: {
			'strict-transport-security': 'max-age=31536000',
			'content-security-policy': "default-src 'self'",
			'x-frame-options': 'DENY',
			'referrer-policy': 'no-referrer'
		},
		websocket: {
			...websocketOptions,
			...(process.env.FIXTURE_ENV_PREFIX ? { upgradeRateLimit: 1, upgradeRateLimitWindow: 60 } : {})
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
	kit: { adapter, paths: { base: process.env.FIXTURE_BASE_PATH || '' } }
};

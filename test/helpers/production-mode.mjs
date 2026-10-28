// Run by test/unit/assertions-production.test.mjs in a child process with
// NODE_ENV=production: the mode in which a framework assertion logs and counts
// instead of throwing. A test process cannot reach it, because the mode is read
// once when the assertions module loads. Prints what it observed as one JSON
// line on stdout.
//
// What it drives is what runs AFTER a check in production: the code behind a
// soft assert, and the code behind a fatal one in the window before the
// scheduled exit. A capturing sink stands in for process.exit.
import './configured-metrics.mjs';

globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = {
	allowedOrigins: 'any',
	path: '/ws',
	handler: 'src/ws-handler.js',
	// A ceiling, so open checks the connection permit the upgrade stamps.
	upgradeAdmission: { maxConnections: 4 }
};

/** @type {string[]} */
const lines = [];
console.error = (...args) => {
	lines.push(args.map(String).join(' '));
};

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { upgradeAdmission } = await import('../../src/runtime/handler/admission.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const {
	CARRY_REQUEST_ID,
	WS_CONNECTION_PERMIT,
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	adjustTotalSubscriptions,
	wsConnections,
	wsCounters
} = await import('../../src/runtime/handler/ws-state.js');
const { devAssert, readAssertionCounts, setFatalSink } = await import('../../src/runtime/utils/assertions.js');
const { metricsSnapshot } = await import('../../src/runtime/handler/metrics.js');

/** @type {number[]} */
const exits = [];
setFatalSink({ exit: (code) => exits.push(code) });

/** @param {Record<PropertyKey, unknown>} data */
function rawSocket(data) {
	/** @type {string[]} */
	const sent = [];
	return {
		data,
		sent,
		readyState: 1,
		send: (/** @type {string} */ payload) => {
			sent.push(payload);
			return payload.length;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (/** @type {() => unknown} */ fn) => fn()
	};
}

/**
 * Socket data as an upgrade through the gate hands it over: a permit acquired
 * from the ceiling and the marker that says this socket owns it.
 *
 * @param {Record<PropertyKey, unknown>} data
 */
function admitted(data) {
	if (!upgradeAdmission.tryAcquireConnection()) throw new Error('the fixture ceiling is full');
	return { ...data, [WS_CONNECTION_PERMIT]: true };
}

/** @type {Record<string, unknown>} */
const out = {};

/** Run `fn`, recording whether it threw rather than letting it end the script. */
async function outcome(/** @type {() => unknown} */ fn) {
	try {
		return { value: await fn() };
	} catch (err) {
		return { threw: String(err) };
	}
}

// An open whose request id did not arrive: reported, and the connection still
// gets an id every log line for it can correlate on. It carries its permit, as
// every socket the upgrade hands over does.
const carried = rawSocket(admitted({}));
out.carryOpen = await outcome(() => websocketHandlers.open(carried));
out.mintedId = carried.data[WS_PLATFORM]?.requestId ?? null;

// An open with no permit: stopped before anything is built - no platform, no
// welcome frame, not registered - so nothing runs on a socket whose accounting
// cannot be trusted before the scheduled exit.
const stray = rawSocket({ [CARRY_REQUEST_ID]: 'stray' });
out.strayOpen = await outcome(() => websocketHandlers.open(stray));
out.stray = {
	platform: stray.data[WS_PLATFORM] !== undefined,
	subscriptions: stray.data[WS_SUBSCRIPTIONS] !== undefined,
	sent: stray.sent.length,
	registered: wsConnections.has(wsFacade(stray))
};

// A connection whose subscription slot stopped being a Set: the subscribe,
// unsubscribe and subscribe-batch lanes answer their caller instead of throwing
// a TypeError out of it, and its close still runs the whole teardown.
const broken = rawSocket(admitted({ [CARRY_REQUEST_ID]: 'broken' }));
websocketHandlers.open(broken);
broken.data[WS_SUBSCRIPTIONS] = ['room'];
out.subscribe = await outcome(() => platform.subscribe(wsFacade(broken), 'room'));
out.unsubscribe = await outcome(() => platform.unsubscribe(wsFacade(broken), 'room'));
out.batch = await outcome(() =>
	websocketHandlers.message(broken, JSON.stringify({ type: 'subscribe-batch', topics: ['room'], ref: 1 }))
);
out.batchFrames = broken.sent.slice(1);
broken.readyState = 3;
out.close = await outcome(() => websocketHandlers.close(broken, 1000, ''));
out.totalAfterClose = wsCounters.totalSubscriptions;
out.detachedAfterClose = (await outcome(() => wsFacade(broken).getUserData())).threw !== undefined;
out.permitsAfterClose = upgradeAdmission.connectionPermits;

// A release with no install behind it: clamped at zero, and reported.
out.totalBefore = wsCounters.totalSubscriptions;
adjustTotalSubscriptions(-(out.totalBefore + 3));
out.totalAfter = wsCounters.totalSubscriptions;

// devAssert is a complete no-op in production.
out.devAssert = await outcome(() => devAssert(false, 'never reported in production'));

// The exits were scheduled on microtasks; this turn has given them all a run.
await Promise.resolve();
out.exits = exits;
out.counts = Object.fromEntries(readAssertionCounts());
out.lines = lines;
out.metrics = (await metricsSnapshot())
	.split('\n')
	.filter((line) => line.startsWith('framework_assertion_violations_total'));
process.stdout.write(JSON.stringify(out) + '\n');

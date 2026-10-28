import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the runtime checks its own invariants, and which tier each check is.
// The categories and tiers are svelte-adapter-uws's for the same invariant, so a
// report reads the same on either adapter. Two halves: the source scan pins
// every site to its tier (a fatal quietly demoted to a log line is the
// regression it exists for), and the driven tests reach each site that a
// corrupted slot can reach, through the real handlers. The healthy side is the
// rest of this suite, which runs in test mode: any spurious violation fails it.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';

const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { platform } = await import('../../src/runtime/handler/platform.js');
const { wsFacade } = await import('../../src/runtime/handler/ws-facade.js');
const { flushCoalescedFor } = await import('../../src/runtime/handler/coalesced.js');
const { chargePublishEgress } = await import('../../src/runtime/handler/publish-egress.js');
const {
	WS_COALESCED,
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	adjustTotalSubscriptions,
	topicPublishStats,
	wsCounters
} = await import('../../src/runtime/handler/ws-state.js');
const { _resetAssertionCountsForTest, readAssertionCounts } = await import('../../src/runtime/utils/assertions.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

// - the source scan ----------------------------------------------------------

/**
 * Every site, by category: its tier and the file it lives in. EXACT in both
 * directions - an unlisted site fails, and so does a listed one that is gone.
 * `count` is set where one invariant is checked at several sites.
 */
const SITES = {
	'ws.connection-permit-carrier': { tier: 'fatal', file: 'handler/ws.js' },
	'ws.platform-double-init': { tier: 'fatal', file: 'handler/ws.js' },
	'ws.platform-missing-in-message': { tier: 'fatal', file: 'handler/ws.js' },
	'ws.request-id-carry': { tier: 'assert', file: 'handler/ws.js' },
	'ws.request-id-leak': { tier: 'assert', file: 'handler/ws.js' },
	'ws.platform-missing-in-resume': { tier: 'assert', file: 'handler/ws.js' },
	'ws.platform-missing-in-drain': { tier: 'assert', file: 'handler/ws.js' },
	'ws.platform-missing-in-close': { tier: 'assert', file: 'handler/ws.js' },
	'subs.shape-batch': { tier: 'assert', file: 'handler/ws.js' },
	'subs.shape': { tier: 'fatal', file: 'handler/platform.js' },
	'subs.shape-unsubscribe': { tier: 'assert', file: 'handler/platform.js' },
	// Soft on purpose: one accounting hook every membership change goes
	// through, and a transient dip on a close path must not end the process.
	'subs.total-negative': { tier: 'assert', file: 'handler/ws-state.js' },
	// publish, publishWire, publishGame, and each entry of publishWireBatch.
	'envelope.empty': { tier: 'fatal', file: 'handler/platform.js', count: 4 },
	'envelope.send-empty': { tier: 'assert', file: 'handler/platform.js' },
	'envelope.batch-empty': { tier: 'assert', file: 'handler/platform.js' },
	'coalesce.userdata-pending-type': { tier: 'assert', file: 'handler/platform.js' },
	'coalesce.pending-type': { tier: 'assert', file: 'handler/coalesced.js' },
	'coalesce.entry-topic-type': { tier: 'assert', file: 'handler/coalesced.js' },
	'coalesce.entry-event-type': { tier: 'assert', file: 'handler/coalesced.js' },
	'topic.stats-shape': { tier: 'assert', file: 'handler/publish-egress.js' }
};

const runtimeDir = fileURLToPath(new URL('../../src/runtime/', import.meta.url));

/** @returns {string[]} */
function runtimeFiles(/** @type {string} */ dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...runtimeFiles(path));
		else if (name.endsWith('.js')) out.push(path);
	}
	return out;
}

/**
 * Every `assert(` / `fatal(` call on a code line of the runtime, with its
 * category. Comment lines are skipped - prose mentions `fatal()` - and a call
 * whose category is not a single-quoted dot-name on the call's own line lands
 * in `unparsed` rather than being missed, so the scan cannot pass by failing to
 * read a site.
 */
function scanSites() {
	/** @type {Array<{ tier: string, category: string, file: string }>} */
	const found = [];
	/** @type {string[]} */
	const unparsed = [];
	for (const path of runtimeFiles(runtimeDir)) {
		const file = relative(runtimeDir, path).split('\\').join('/');
		// The module that defines them, and the one that formats their line.
		if (file === 'utils/assertions.js' || file === 'diagnostic-format.js') continue;
		const lines = readFileSync(path, 'utf8').split(/\r?\n/);
		for (const [i, line] of lines.entries()) {
			const code = line.trimStart();
			if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
			for (const call of line.matchAll(/\b(assert|fatal)\(/g)) {
				// Up to the first quoted dot-name: a condition can hold a plain
				// string literal (`typeof t === 'string'`), never a dotted one.
				const category = /^(?:assert|fatal)\([^;]*?'([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)'/.exec(
					line.slice(call.index)
				);
				if (category) found.push({ tier: call[1], category: category[1], file });
				else unparsed.push(`${file}:${i + 1}`);
			}
		}
	}
	return { found, unparsed };
}

test('every runtime invariant check is listed, at its tier, in its file', () => {
	const { found, unparsed } = scanSites();
	assert.deepEqual(
		unparsed,
		[],
		'every assert()/fatal() call names its category as a single-quoted literal on its own line'
	);
	for (const site of found) {
		const expected = SITES[/** @type {keyof typeof SITES} */ (site.category)];
		assert.ok(expected, `${site.category} (${site.file}) is not listed - add it with svelte-adapter-uws's tier`);
		assert.equal(site.tier, expected.tier, `${site.category} is ${expected.tier}(), not ${site.tier}()`);
		assert.equal(site.file, expected.file, `${site.category} lives in ${expected.file}`);
	}
	for (const [category, expected] of Object.entries(SITES)) {
		const count = found.filter((s) => s.category === category).length;
		assert.equal(count, /** @type {{ count?: number }} */ (expected).count ?? 1, `${category} sites`);
	}
});

test('the runtime imports assert and fatal under their own names', () => {
	// The scan above finds a site by name. An aliased import - `fatal as stop`
	// - a namespace import, a re-export or a dynamic import would hide every
	// call made through it. Specifiers are resolved against the importing file,
	// so a sibling's `./assertions.js` is held to the same rule.
	const target = join(runtimeDir, 'utils', 'assertions.js');
	for (const path of runtimeFiles(runtimeDir)) {
		const file = relative(runtimeDir, path).split('\\').join('/');
		const source = readFileSync(path, 'utf8');
		const isTarget = (/** @type {string} */ spec) => spec.startsWith('.') && resolve(dirname(path), spec) === target;
		const imports = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].filter((m) => isTarget(m[1])).length;
		const named = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)].filter((m) => isTarget(m[2]));
		const dynamic = [...source.matchAll(/import\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].filter((m) => isTarget(m[1])).length;
		assert.equal(dynamic, 0, `${file} imports the assertions dynamically`);
		assert.equal(named.length, imports, `${file} imports the assertions other than by name`);
		for (const m of named) {
			assert.doesNotMatch(m[1], /\bas\b/, `${file} renames an assertion: {${m[1]}}`);
		}
	}
});

test('a missing connection permit stops open before anything is built', () => {
	// The return after the fatal() is what keeps a socket with untrusted
	// accounting from being registered in production, where fatal() only
	// schedules the exit.
	const source = readFileSync(join(runtimeDir, 'handler/ws.js'), 'utf8');
	assert.match(source, /fatal\(permitCarried, 'ws\.connection-permit-carrier', null\);\s*if \(!permitCarried\) return;/);
});

// - the driven sites ---------------------------------------------------------

/** A stand-in for Bun's raw socket, carrying what a real upgrade hands `open`. */
function rawSocket() {
	return {
		data: upgradeData(),
		readyState: 1,
		send: (/** @type {string} */ payload) => payload.length,
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (/** @type {() => unknown} */ fn) => fn()
	};
}

/** Open one connection through the real handler, so its slots are real. */
function openSocket() {
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return raw;
}

/** The test-mode error a violation of `category` throws. */
const violation = (/** @type {'assert' | 'fatal'} */ tier, /** @type {string} */ category) =>
	new RegExp(`^Error: adapter-bunserve ${tier}: ${category.replace(/[.]/g, '\\.')}$`);

/** @type {typeof console.error} */
const realError = console.error;

beforeEach(() => {
	__setHooks({});
	_resetAssertionCountsForTest();
	// A fatal() logs its line before the test-mode throw; the line is pinned in
	// assertions.test.mjs, and here it would only be noise.
	console.error = () => {};
});

/** Restore console.error after each driven case. */
function restore() {
	console.error = realError;
}

test('a second open on one connection is fatal', () => {
	try {
		const raw = openSocket();
		const closed = [];
		raw.close = (...args) => closed.push(args);
		// Setup containment catches the test-mode fatal throw; the invariant
		// still records its fatal tier and closes the corrupted connection.
		assert.doesNotThrow(() => websocketHandlers.open(raw));
		assert.equal(readAssertionCounts().get('ws.platform-double-init'), 1);
		assert.deepEqual(closed, [[1011, 'Connection setup failed']]);
	} finally {
		restore();
	}
});

test('a message on a connection that lost its platform slot is fatal', async () => {
	try {
		const raw = openSocket();
		delete raw.data[WS_PLATFORM];
		await assert.rejects(websocketHandlers.message(raw, 'app frame'), violation('fatal', 'ws.platform-missing-in-message'));
	} finally {
		restore();
	}
});

test('a drain on a connection that lost its platform slot is reported', () => {
	try {
		const raw = openSocket();
		delete raw.data[WS_PLATFORM];
		assert.throws(() => websocketHandlers.drain(raw), violation('assert', 'ws.platform-missing-in-drain'));
	} finally {
		restore();
	}
});

test('a close on a connection that lost its platform slot is reported', () => {
	try {
		const raw = openSocket();
		delete raw.data[WS_PLATFORM];
		raw.readyState = 3;
		assert.throws(() => websocketHandlers.close(raw, 1000, ''), violation('assert', 'ws.platform-missing-in-close'));
	} finally {
		restore();
	}
});

test('a subscribe on a connection whose subscription slot is not a Set is fatal', async () => {
	try {
		const raw = openSocket();
		raw.data[WS_SUBSCRIPTIONS] = ['room'];
		await assert.rejects(platform.subscribe(wsFacade(raw), 'room'), violation('fatal', 'subs.shape'));
	} finally {
		restore();
	}
});

test('an unsubscribe on a connection whose subscription slot is not a Set is reported', () => {
	try {
		const raw = openSocket();
		raw.data[WS_SUBSCRIPTIONS] = ['room'];
		assert.throws(() => platform.unsubscribe(wsFacade(raw), 'room'), violation('assert', 'subs.shape-unsubscribe'));
	} finally {
		restore();
	}
});

test('a subscribe-batch on a connection whose subscription slot is not a Set is reported', async () => {
	try {
		const raw = openSocket();
		raw.data[WS_SUBSCRIPTIONS] = ['room'];
		await assert.rejects(
			websocketHandlers.message(raw, JSON.stringify({ type: 'subscribe-batch', topics: ['room'] })),
			violation('assert', 'subs.shape-batch')
		);
	} finally {
		restore();
	}
});

test('a release that takes the subscription total below zero is reported with the total', () => {
	try {
		const before = wsCounters.totalSubscriptions;
		assert.throws(
			() => adjustTotalSubscriptions(-(before + 2)),
			(/** @type {any} */ err) => {
				assert.match(String(err), violation('assert', 'subs.total-negative'));
				assert.deepEqual(err.context, { totalSubscriptions: -2 });
				return true;
			}
		);
	} finally {
		restore();
	}
});

test('a release the total has no install for is clamped and reported, through unsubscribe', () => {
	try {
		const raw = openSocket();
		// Held without the total having counted it: drifted bookkeeping.
		raw.data[WS_SUBSCRIPTIONS].add('room');
		wsCounters.totalSubscriptions = 0;
		assert.throws(
			() => platform.unsubscribe(wsFacade(raw), 'room'),
			(/** @type {any} */ err) => {
				assert.match(String(err), violation('assert', 'subs.total-negative'));
				assert.deepEqual(err.context, { totalSubscriptions: -1 });
				return true;
			}
		);
	} finally {
		wsCounters.totalSubscriptions = 0;
		restore();
	}
});

test('and through the close of a connection holding topics the total never counted', () => {
	try {
		const raw = openSocket();
		raw.data[WS_SUBSCRIPTIONS].add('a');
		raw.data[WS_SUBSCRIPTIONS].add('b');
		wsCounters.totalSubscriptions = 0;
		raw.readyState = 3;
		// Released one topic at a time, so the first uncounted one is reported.
		assert.throws(
			() => websocketHandlers.close(raw, 1000, ''),
			(/** @type {any} */ err) => {
				assert.match(String(err), violation('assert', 'subs.total-negative'));
				assert.deepEqual(err.context, { totalSubscriptions: -1 });
				return true;
			}
		);
	} finally {
		wsCounters.totalSubscriptions = 0;
		restore();
	}
});

test('a coalesced queue that is not a Map is reported, at the send and at the flush', () => {
	try {
		const raw = openSocket();
		raw.data[WS_COALESCED] = { size: 1 };
		assert.throws(
			() => platform.sendCoalesced(wsFacade(raw), { key: 'k', topic: 't', event: 'e', data: 1 }),
			violation('assert', 'coalesce.userdata-pending-type')
		);
		assert.throws(() => flushCoalescedFor(wsFacade(raw)), violation('assert', 'coalesce.pending-type'));
	} finally {
		restore();
	}
});

test('a queued coalesced entry without a string topic or event is reported at the flush', () => {
	try {
		const raw = openSocket();
		raw.data[WS_COALESCED] = new Map([['k', { topic: 7, event: 'e', data: 1 }]]);
		assert.throws(() => flushCoalescedFor(wsFacade(raw)), violation('assert', 'coalesce.entry-topic-type'));
		raw.data[WS_COALESCED] = new Map([['k', { topic: 't', event: 7, data: 1 }]]);
		assert.throws(() => flushCoalescedFor(wsFacade(raw)), violation('assert', 'coalesce.entry-event-type'));
	} finally {
		restore();
	}
});

test('per-topic publish stats of the wrong shape are reported with the field types', () => {
	try {
		// Each field on its own, so the check cannot lose one of the three.
		for (const [stats, context] of [
			[{ m: '1', b: 0, d: 0 }, { messagesType: 'string', bytesType: 'number', deliveriesType: 'number' }],
			[{ m: 0, b: null, d: 0 }, { messagesType: 'number', bytesType: 'object', deliveriesType: 'number' }],
			[{ m: 0, b: 0, d: undefined }, { messagesType: 'number', bytesType: 'number', deliveriesType: 'undefined' }]
		]) {
			topicPublishStats.set('stats-room', stats);
			assert.throws(
				() => chargePublishEgress('stats-room', null, 1, 1, 10, 10),
				(/** @type {any} */ err) => {
					assert.match(String(err), violation('assert', 'topic.stats-shape'));
					assert.deepEqual(err.context, context);
					return true;
				}
			);
		}
	} finally {
		topicPublishStats.delete('stats-room');
		restore();
	}
});

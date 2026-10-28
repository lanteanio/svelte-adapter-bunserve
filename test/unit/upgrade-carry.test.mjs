import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDSHAKE } from '../helpers/handshake.mjs';

// What the upgrade carries to `open` arrives whatever the process has installed
// on Object.prototype. Driven through the real `tryUpgrade` and the real `open`
// handler, joined the way Bun joins them: the object handed to
// `server.upgrade(req, { data })` is the socket's `data` in `open`.
globalThis.ENV_PREFIX = '';
globalThis.WS_PATH = '/ws';
globalThis.WS_OPTIONS = { allowedOrigins: 'any', path: '/ws', handler: 'src/ws-handler.js' };

const { tryUpgrade } = await import('../../src/runtime/handler/upgrade.js');
const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { WS_PLATFORM } = await import('../../src/runtime/handler/ws-state.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { _resetAssertionCountsForTest, readAssertionCounts } = await import('../../src/runtime/utils/assertions.js');

/** The string key the request id used to ride. */
const OLD_KEY = '__adapter_request_id';

const APP_KEY = Symbol('app.session');
const APP_HIDDEN = Symbol('app.hidden');

function rawSocket(data) {
	return {
		data,
		sent: [],
		readyState: 1,
		send(payload) {
			this.sent.push(payload);
			return payload.length;
		},
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
}

/** Upgrade one request, then open the socket on the data it carried. */
async function upgradeAndOpen(headers) {
	let carried = null;
	const srv = {
		upgrade(_req, opts) {
			carried = opts.data;
			return true;
		}
	};
	const req = new Request('http://127.0.0.1/ws', {
		headers: { ...HANDSHAKE, ...headers }
	});
	await tryUpgrade(req, srv, '/ws');
	assert.ok(carried, 'the upgrade was taken');
	const raw = rawSocket(carried);
	websocketHandlers.open(raw);
	return raw;
}

test('the request id arrives in open past an Object.prototype accessor for the old key', async () => {
	__setHooks({});
	let stolen;
	Object.defineProperty(Object.prototype, OLD_KEY, {
		configurable: true,
		set(v) {
			stolen = v;
		},
		get() {
			return undefined;
		}
	});
	try {
		const raw = await upgradeAndOpen({ 'x-request-id': 'carry-probe-1' });
		assert.equal(raw.data[WS_PLATFORM].requestId, 'carry-probe-1');
		assert.equal(stolen, undefined, 'nothing was assigned through the accessor');
	} finally {
		delete Object.prototype[OLD_KEY];
	}
});

test('the carry slot is gone once open has promoted it', async () => {
	__setHooks({});
	const raw = await upgradeAndOpen({ 'x-request-id': 'carry-probe-2' });
	const keys = [...Object.keys(raw.data), ...Object.getOwnPropertySymbols(raw.data)];
	const holding = keys.filter((k) => k !== WS_PLATFORM && raw.data[k] === 'carry-probe-2');
	assert.deepEqual(holding, []);
});

test('an upgrade hook keyed by a Symbol gets its enumerable Symbol keys back in open', async () => {
	__setHooks({
		upgrade: () => {
			const ud = { user: 'u1', [APP_KEY]: 'session-1' };
			Object.defineProperty(ud, APP_HIDDEN, { value: 'not copied', enumerable: false });
			return ud;
		}
	});
	try {
		const raw = await upgradeAndOpen({});
		assert.equal(raw.data.user, 'u1');
		assert.equal(raw.data[APP_KEY], 'session-1');
		assert.equal(Object.prototype.hasOwnProperty.call(raw.data, APP_HIDDEN), false);
	} finally {
		__setHooks({});
	}
});

test('the request-id carrier is private and the permit uses the family symbol', async () => {
	// A registered Symbol.for key could be produced by anyone who knows its name.
	const state = await import('../../src/runtime/handler/ws-state.js');
	assert.equal(Symbol.keyFor(state.CARRY_REQUEST_ID), undefined);
	assert.equal(Symbol.keyFor(state.WS_CONNECTION_PERMIT), 'adapter-uws.ws.connection-permit');
});

test('application userData under the old carrier name arrives untouched', async () => {
	__setHooks({ upgrade: () => ({ [OLD_KEY]: 'the application owns this' }) });
	const raw = await upgradeAndOpen({ 'x-request-id': 'carry-probe-3' });
	assert.equal(raw.data[OLD_KEY], 'the application owns this');
	assert.equal(raw.data[WS_PLATFORM].requestId, 'carry-probe-3');
	__setHooks({});
});

test('a connection whose carried id did not arrive is reported, not silently minted', () => {
	// The upgrade always sets it, so a socket arriving without one means the
	// runtime stopped handing `open` the object the upgrade passed. Under test
	// the report throws; in production the connection is still given a minted
	// id, which assertions-production.test.mjs runs.
	__setHooks({});
	_resetAssertionCountsForTest();
	const raw = rawSocket({});
	assert.doesNotThrow(() => websocketHandlers.open(raw));
	assert.equal(readAssertionCounts().get('ws.request-id-carry'), 1);
	_resetAssertionCountsForTest();
});

test('a hook that returns another connection\'s userData hands over none of the adapter\'s slots', async () => {
	const state = await import('../../src/runtime/handler/ws-state.js');
	__setHooks({});
	const first = await upgradeAndOpen({ 'x-request-id': 'first' });
	// State that connection would have built by using the wire, and a permit.
	first.data[state.WS_TOPIC_IDS] = { byName: new Map([['room', 1]]), next: 2 };
	first.data[state.WS_SHARED_COHORTS] = new Set(['room']);
	first.data[state.WS_CAPS] = new Set(['cap:1']);
	first.data[state.WS_CONNECTION_PERMIT] = true;
	first.data[state.WS_PENDING_SUBSCRIBES] = new Map([['room', { epoch: 0, inflight: 1, granted: false }]]);
	first.data[state.WS_PENDING_SUBSCRIBES_TOTAL] = 1;
	first.data[APP_KEY] = 'app state';

	__setHooks({ upgrade: () => ({ ...first.data, tab: 2 }) });
	try {
		const second = await upgradeAndOpen({ 'x-request-id': 'second' });
		for (const sym of Object.getOwnPropertySymbols(first.data)) {
			if (!state.isConnectionSlot(sym)) continue;
			// Declared at open and never used: nothing to hand over.
			if (first.data[sym] === undefined) continue;
			assert.notEqual(second.data[sym], first.data[sym], `${String(sym)} was not handed over`);
		}
		assert.equal(second.data[WS_PLATFORM].requestId, 'second');
		assert.equal(second.data[APP_KEY], 'app state', 'an application Symbol key still crosses');
		assert.equal(second.data.tab, 2);
	} finally {
		__setHooks({});
	}
});

test('every Symbol the adapter keeps on userData is a known slot', async () => {
	const state = await import('../../src/runtime/handler/ws-state.js');
	for (const [name, value] of Object.entries(state)) {
		if (typeof value === 'symbol') assert.ok(state.isConnectionSlot(value), name);
	}
	// The private slots, as a real open creates them (the welcome frame
	// charges the control budget, for one).
	__setHooks({});
	const raw = await upgradeAndOpen({});
	for (const sym of Object.getOwnPropertySymbols(raw.data)) {
		assert.ok(state.isConnectionSlot(sym), String(sym));
	}
});

test('every Symbol declared in the runtime is a connection slot or known not to be one', async () => {
	// The two tests above see exported Symbols and the ones a bare open
	// creates; a slot written lazily (an in-flight gate, an unsubscribe queue)
	// or declared in another module would slip past both. This reads the
	// source instead: a new Symbol must be added to CONNECTION_SLOTS or here.
	const { readFileSync, readdirSync, statSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { fileURLToPath } = await import('node:url');
	const NOT_SLOTS = new Set([
		'STILL_STREAMING',
		'HOOK_TIMED_OUT',
		'EGRESS_ADMITTED',
		// Opaque batch-admission value, never a property key or connection slot.
		'ADMIT_TOKEN',
		'HOOK_SIDE_EFFECT_ONLY',
		// Process-wide, on globalThis: one per worker however many copies of the
		// subscription helpers are loaded.
		'SUBSCRIPTION_ACCOUNTING_HOOK',
		'REGISTRY_STATES',
		'DERIVED_PREFIXES_KEY',
		'OWNED_PREFIXES_KEY',
		'OPERATIONAL_EVENT_SINK',
		'OPERATIONAL_EVENT_SINK_REGISTRY',
		'REGISTRY_KEY',
		// Ephemeral upgrade carriers do not survive the testing server's open.
		'carry',
		// Platform members, keyed on the base platform object.
		'WS_RELEASE_MEMBERSHIP',
		'WS_COHORT_JOIN',
		'WS_COHORT_LEAVE',
		'WS_REVOKED_UNSUBSCRIBE'
	]);
	const root = new URL('../../src/runtime/', import.meta.url);
	const files = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.js')) files.push(path);
		}
	};
	walk(fileURLToPath(root));
	const stateSource = readFileSync(new URL('../../src/runtime/handler/ws-state.js', import.meta.url), 'utf8');
	const block = stateSource.slice(stateSource.indexOf('const CONNECTION_SLOTS = new Set(['));
	const slotNames = new Set(block.slice(0, block.indexOf(']);')).match(/\b[A-Z][A-Z0-9_]+\b/g));
	// The public testing server owns a separate, fully declared socket shape.
	const testingSource = readFileSync(new URL('../../src/runtime/testing-slots.js', import.meta.url), 'utf8');
	const testingBlock = testingSource.slice(testingSource.indexOf('const TESTING_CONNECTION_SLOTS = Object.freeze(['));
	for (const name of testingBlock.slice(0, testingBlock.indexOf(']);')).match(/\bWS_[A-Z0-9_]+\b/g)) slotNames.add(name);
	const declared = [];
	for (const file of files) {
		for (const m of readFileSync(file, 'utf8').matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*Symbol(?:\.for)?\(/g)) {
			declared.push([m[1], file]);
		}
	}
	assert.ok(declared.length >= 20, 'the scan found the runtime\'s Symbols');
	for (const [name, file] of declared) {
		assert.ok(slotNames.has(name) || NOT_SLOTS.has(name), `${name} (${file}) is in CONNECTION_SLOTS or known not to be a slot`);
	}
});


test('upgrade receives the event and returns handshake headers separately from userData', async () => {
	let event;
	let accepted;
	__setHooks({ upgrade: (value) => {
		event = value;
		return { __upgradeResponse: true, userData: { user: 'ada' }, headers: { 'x-version': 'v1' } };
	} });
	const req = new Request('http://127.0.0.1/ws?token=one', { headers: { ...HANDSHAKE, cookie: 'sid=hello%20world', 'x-request-id': 'event-1' } });
	const srv = { requestIP: () => ({ address: '203.0.113.7' }), upgrade: (_req, options) => { accepted = options; return true; } };
	await tryUpgrade(req, srv, '/ws');
	assert.deepEqual(Object.keys(event).sort(), ['cookies', 'headers', 'remoteAddress', 'requestId', 'traceContext', 'url']);
	assert.equal(event.cookies.sid, 'hello world');
	assert.equal(event.headers.cookie, 'sid=hello%20world');
	assert.equal(event.url, '/ws?token=one');
	assert.equal(event.requestId, 'event-1');
	assert.equal(event.traceContext, null);
	assert.equal(event.remoteAddress, '203.0.113.7');
	assert.equal(accepted.data.remoteAddress, '203.0.113.7');
	assert.equal(accepted.data.user, 'ada');
	assert.equal(accepted.data.__upgradeResponse, undefined);
	assert.equal(accepted.headers.get('x-version'), 'v1');
	__setHooks({ upgrade: () => ({ remoteAddress: 'custom' }) });
	await tryUpgrade(req, srv, '/ws');
	assert.equal(accepted.data.remoteAddress, 'custom');
	__setHooks({});
	await tryUpgrade(req, srv, '/ws');
	assert.equal(accepted.data.remoteAddress, '203.0.113.7');
});


test('handshake response headers are captured from the wrapper only once', async () => {
	let reads = 0;
	let accepted;
	__setHooks({ upgrade: () => ({ __upgradeResponse: true, userData: {}, get headers() { reads++; return reads === 1 ? { 'x-test': 'original' } : { 'x-test': 'changed' }; } }) });
	const req = new Request('http://127.0.0.1/ws', { headers: HANDSHAKE });
	await tryUpgrade(req, { upgrade: (_req, options) => { accepted = options; return true; } }, '/ws');
	assert.equal(reads, 1);
	assert.equal(accepted.headers.get('x-test'), 'original');
	__setHooks({});
});


test('upgrade headers expand cookie arrays after snapshotting values once', async () => {
	const cookies = ['first=1', 'second=2'];
	__setHooks({ upgrade: () => ({ __upgradeResponse: true, userData: {}, headers: {
		'set-cookie': cookies, get later() { cookies[0] = 'bad\r\nsplit'; return 'tab\tvalue'; }
	} }) });
	let accepted;
	const srv = { requestIP: () => ({ address: '127.0.0.1' }), upgrade(_req, options) { accepted = options; return true; } };
	assert.equal(await tryUpgrade(new Request('http://127.0.0.1/ws', { headers: HANDSHAKE }), srv, '/ws'), undefined);
	assert.deepEqual(accepted.headers.getSetCookie(), ['first=1', 'second=2']);
	assert.equal(accepted.headers.get('later'), 'tab\tvalue');
});

for (const [path, expected] of [['/ws', '/ws'], ['/ws?', '/ws'], ['/ws??', '/ws??'], ['/ws?x?', '/ws?x?']]) {
	test('upgrade event preserves query shape ' + path, async () => {
		let seen;
		__setHooks({ upgrade: event => { seen = event.url; return {}; } });
		try {
			await tryUpgrade(new Request('http://127.0.0.1' + path, { headers: HANDSHAKE }), { upgrade: () => true }, '/ws');
			assert.equal(seen, expected);
		} finally { __setHooks({}); }
	});
}


test('an own __proto__ upgrade key is data and keeps the ordinary prototype', async () => {
 __setHooks({ upgrade: () => JSON.parse('{"__proto__":1,"user":"safe"}') });
 try {
  const raw = await upgradeAndOpen({});
  assert.equal(Object.getPrototypeOf(raw.data), Object.prototype);
  assert.equal(Object.hasOwn(raw.data, '__proto__'), true);
  assert.equal(raw.data.__proto__, 1);
 } finally { __setHooks({}); }
});

for (const value of [true, 'user-1', 7]) {
 test(`truthy primitive upgrade data is a correlated hook failure: ${typeof value}`, async () => {
  __setHooks({ upgrade: () => value });
  try {
   const response = await tryUpgrade(new Request('http://127.0.0.1/ws', { headers: { ...HANDSHAKE, 'x-request-id': 'primitive-123' } }), { upgrade() { assert.fail('must not upgrade'); } }, '/ws');
   assert.equal(response.status, 500);
   assert.equal(response.headers.get('x-request-id'), 'primitive-123');
   assert.equal(response.headers.get('content-type'), 'text/plain');
  } finally { __setHooks({}); }
 });
}

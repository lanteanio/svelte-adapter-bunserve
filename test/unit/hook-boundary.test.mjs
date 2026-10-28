import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCloseHook, runDrainHook, runMessageHook, runOpenHook } from '../../src/runtime/utils/hook-boundary.js';

// A failing hook costs its own connection and nothing else: `open`, `message`
// and `drain` close it with 1011 and a reason naming the hook, `close` only
// logs. The line is the one svelte-adapter-uws prints, id included.

function fakeWs({ endThrows = false } = {}) {
	return {
		ends: [],
		end(code, reason) {
			if (endThrows) throw new Error('closed');
			this.ends.push([code, reason]);
		}
	};
}

async function captureErrors(fn) {
	const lines = [];
	const real = console.error;
	console.error = (...args) => lines.push(args);
	try {
		await fn();
		// Let a rejection's handler run.
		for (let i = 0; i < 5; i++) await Promise.resolve();
	} finally {
		console.error = real;
	}
	return lines;
}

const CASES = [
	['open', runOpenHook, '[ws] the open hook threw [ADAPTER-ERR-OPEN-HOOK]', 'Open handler error'],
	['drain', runDrainHook, '[ws] the drain hook threw [ADAPTER-ERR-DRAIN-HOOK]', 'Drain handler error'],
	['message', runMessageHook, '[ws] the message hook threw [ADAPTER-ERR-MESSAGE-HOOK]', 'Message handler error']
];

for (const [name, run, line, reason] of CASES) {
	test(`a throwing ${name} hook closes its connection with 1011 and prints the family line`, async () => {
		const ws = fakeWs();
		const err = new Error('boom');
		const lines = await captureErrors(() => run({ [name]: () => { throw err; } }, ws, {}));
		assert.deepEqual(ws.ends, [[1011, reason]]);
		assert.equal(lines.length, 1);
		assert.equal(lines[0][0], line);
		assert.equal(lines[0][1], err, 'the original error is printed with it');
	});

	test(`a rejecting ${name} hook closes its connection the same way`, async () => {
		const ws = fakeWs();
		const lines = await captureErrors(() => run({ [name]: async () => { throw new Error('later'); } }, ws, {}));
		assert.deepEqual(ws.ends, [[1011, reason]]);
		assert.equal(lines.length, 1);
		assert.equal(lines[0][0], line);
	});
}

test('a throwing close hook is logged and nothing else', async () => {
	const ws = fakeWs();
	const lines = await captureErrors(() => runCloseHook({ close: () => { throw new Error('boom'); } }, ws, {}));
	assert.deepEqual(ws.ends, []);
	assert.equal(lines[0][0], '[ws] the close hook threw [ADAPTER-ERR-CLOSE-HOOK]');
});

test('an async close hook hands back a settle the shutdown drain can wait on, rejection included', async () => {
	let finish;
	const settling = runCloseHook({ close: () => new Promise((resolve) => { finish = resolve; }) }, fakeWs(), {});
	assert.ok(settling instanceof Promise);
	finish();
	await settling;
	const lines = await captureErrors(async () => {
		const rejected = runCloseHook({ close: async () => { throw new Error('x'); } }, fakeWs(), {});
		await rejected; // resolves: the rejection is contained
	});
	assert.equal(lines.length, 1);
});

test('a hook is called as a method of the object that holds it, with the context it was given', () => {
	const handlers = {
		seen: null,
		open(ws, ctx) {
			this.seen = { self: this, ctx };
		}
	};
	const ctx = { platform: {} };
	runOpenHook(handlers, fakeWs(), ctx);
	assert.equal(handlers.seen.self, handlers);
	assert.equal(handlers.seen.ctx, ctx);
});

test('an open export that is not a function is reported for the connection, not skipped', async () => {
	const ws = fakeWs();
	const lines = await captureErrors(() => runOpenHook({ open: 42 }, ws, {}));
	assert.deepEqual(ws.ends, [[1011, 'Open handler error']]);
	assert.ok(lines[0][1] instanceof TypeError);
});

test('a message export that is not a function is not a message hook', async () => {
	const ws = fakeWs();
	const lines = await captureErrors(() => runMessageHook({ message: 42 }, ws, {}));
	assert.deepEqual(ws.ends, []);
	assert.deepEqual(lines, []);
});

test('an absent hook is skipped', async () => {
	const lines = await captureErrors(() => {
		runOpenHook({}, fakeWs(), {});
		runDrainHook(undefined, fakeWs(), {});
		runCloseHook({ close: null }, fakeWs(), {});
	});
	assert.deepEqual(lines, []);
});

test('a returned value whose then getter throws is contained', async () => {
	const ws = fakeWs();
	const hostile = {
		get then() {
			throw new Error('then getter');
		}
	};
	const lines = await captureErrors(() => runOpenHook({ open: () => hostile }, ws, {}));
	assert.deepEqual(ws.ends, [[1011, 'Open handler error']]);
	assert.equal(lines.length, 1);
});

test('a connection already closed when its hook fails stays a log line', async () => {
	const ws = fakeWs({ endThrows: true });
	const lines = await captureErrors(() => runOpenHook({ open: () => { throw new Error('boom'); } }, ws, {}));
	assert.equal(lines.length, 1, 'reported, and the failed close is swallowed');
});

test('every failure prints its line: no throttle, since each one costs a connection', async () => {
	const lines = await captureErrors(() => {
		for (let i = 0; i < 11; i++) runMessageHook({ message: () => { throw new Error('again'); } }, fakeWs(), {});
	});
	assert.equal(lines.length, 11);
});

test('a console.error that throws does not keep the failed connection open', () => {
	const ws = fakeWs();
	const real = console.error;
	console.error = () => {
		throw new Error('logger down');
	};
	try {
		runOpenHook({ open: () => { throw new Error('boom'); } }, ws, {});
	} finally {
		console.error = real;
	}
	assert.deepEqual(ws.ends, [[1011, 'Open handler error']]);
});

test('drain and close exports that are set but not functions are reported too', async () => {
	const drained = fakeWs();
	const closed = fakeWs();
	const lines = await captureErrors(() => {
		runDrainHook({ drain: 'yes' }, drained, {});
		runCloseHook({ close: 42 }, closed, {});
	});
	assert.deepEqual(drained.ends, [[1011, 'Drain handler error']]);
	assert.deepEqual(closed.ends, [], 'a close hook only logs');
	assert.deepEqual(
		lines.map((l) => l[0]),
		['[ws] the drain hook threw [ADAPTER-ERR-DRAIN-HOOK]', '[ws] the close hook threw [ADAPTER-ERR-CLOSE-HOOK]']
	);
	assert.ok(lines.every((l) => l[1] instanceof TypeError));
});

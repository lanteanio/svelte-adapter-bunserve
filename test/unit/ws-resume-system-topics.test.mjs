import { test } from 'node:test';
import assert from 'node:assert/strict';

// Standalone resume leaves map shape validation to the application hook.
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = { allowSystemTopicSubscribe: true };
globalThis.WS_PATH = '/ws';


const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
const { __setHooks } = await import('../helpers/ws-handler-stub.mjs');
const { upgradeData } = await import('../helpers/upgrade-data.mjs');

function rawSocket() {
	const sent = [];
	const subscribed = new Set();
	return {
		data: upgradeData(),
		sent,
		subscribed,
		readyState: 1,
		send(payload) {
			sent.push(payload);
			return typeof payload === 'string' ? payload.length : payload.byteLength;
		},
		subscribe(topic) {
			subscribed.add(topic);
			return true;
		},
		unsubscribe: (topic) => subscribed.delete(topic),
		isSubscribed: (topic) => subscribed.has(topic),
		close() {},
		terminate() {},
		getBufferedAmount: () => 0,
		cork: (fn) => fn()
	};
}

function openSocket(hooks) {
	__setHooks(hooks);
	const raw = rawSocket();
	websocketHandlers.open(raw);
	return raw;
}

const send = (raw, frame) => websocketHandlers.message(raw, JSON.stringify(frame));

test('standalone resume forwards own system-topic and prototype-named keys', async () => {
	let ctx;
	const raw = openSocket({ resume: (_ws, value) => { ctx = value; } });
	const lastSeenSeqs = { room: 1, __presence: 2, ['__proto__']: 3 };
	const lastSeenEpochs = { __presence: 7, ['__proto__']: 9 };
	await send(raw, { type: 'resume', sessionId: 's', lastSeenSeqs, lastSeenEpochs });
	assert.deepEqual(ctx.lastSeenSeqs, lastSeenSeqs);
	assert.deepEqual(ctx.lastSeenEpochs, lastSeenEpochs);
	assert.equal(Object.getPrototypeOf(ctx.lastSeenSeqs), Object.prototype);
	assert.ok(Object.hasOwn(ctx.lastSeenSeqs, '__proto__'));
	websocketHandlers.close(raw, 1000, '');
});

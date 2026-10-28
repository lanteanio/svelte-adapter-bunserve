import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = { compression: true };
globalThis.WS_PATH = '/ws';
const { platform } = await import('../../src/runtime/handler/platform.js');
const { setServer } = await import('../../src/runtime/handler/ws-state.js');
const sent = [];
setServer({ subscriberCount: () => 1, publish(topic, payload, compress) { sent.push({ topic, envelope: JSON.parse(payload), compress }); return payload.length; } });

test('scoped helpers carry explicit sequences, jitter and compression to native publishing', () => {
	const helper = platform.topic('room');
	const calls = [
		['publish', ['changed', { value: 1 }], 'changed'],
		['created', [{ value: 2 }], 'created'],
		['updated', [{ value: 3 }], 'updated'],
		['deleted', [{ value: 4 }], 'deleted'],
		['set', [5], 'set'], ['increment', [undefined], 'increment'], ['decrement', [undefined], 'decrement']
	];
	for (let i = 0; i < calls.length; i++) {
		const [method, args, event] = calls[i];
		helper[method](...args, { seq: i + 10, compress: false, jitterMs: 20 });
		assert.equal(sent[i].envelope.seq, i + 10, method);
		assert.equal(sent[i].envelope.j, 20, method);
		assert.equal(sent[i].compress, false, method);
		assert.equal(sent[i].envelope.event, event, method);
	}
	helper.created('compressed', { seq: false });
	assert.equal(sent.at(-1).compress, true);
	assert.equal(Object.hasOwn(sent.at(-1).envelope, 'seq'), false);
});


test('a cached helper passes the complete options object to a replacement publisher', () => {
	const helper = platform.topic('wrapped');
	const original = platform.publish;
	const seen = [];
	const options = { relay: false, seq: 91, compress: false, jitterMs: 30 };
	try {
		platform.publish = (...args) => { seen.push(args); return true; };
		helper.publish('event', { value: 1 }, options);
		assert.deepEqual(seen, [['wrapped', 'event', { value: 1 }, options]]);
		assert.equal(seen[0][3], options);
	} finally { platform.publish = original; }
});

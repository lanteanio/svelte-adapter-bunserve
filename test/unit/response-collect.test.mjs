import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImmediate } from '../../src/runtime/handler/response-collect.js';
import { responseChunkBytes } from '../../src/runtime/handler/response-body.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const stream = chunks => new ReadableStream({ start(out) { for (const chunk of chunks) out.enqueue(chunk); out.close(); } });

test('response chunks preserve exact byte views and encode strings as UTF-8', () => {
	const storage = Uint8Array.from([90, 1, 2, 3, 4, 91]);
	const bytes = storage.subarray(1, 5);
	assert.equal(responseChunkBytes(bytes), bytes);
	assert.deepEqual(responseChunkBytes(new DataView(storage.buffer, 1, 4)), bytes);
	assert.deepEqual(responseChunkBytes(new Uint16Array(storage.buffer, 2, 2)), storage.subarray(2));
	assert.deepEqual(responseChunkBytes(storage.buffer), storage);
	assert.deepEqual(responseChunkBytes('M\u00fcller'), new TextEncoder().encode('M\u00fcller'));
	for (const value of [3, {}, null, undefined]) assert.throws(() => responseChunkBytes(value), TypeError);
});

test('finite ready streams and transform chains collect exact bytes and release their reader', async () => {
	let body = stream(['one two']);
	for (let i = 0; i < 3; i++) body = body.pipeThrough(new TransformStream());
	const result = await collectImmediate(body);
	assert.equal(result.complete, true);
	assert.equal(new TextDecoder().decode(result.bytes), 'one two');
	assert.equal(body.locked, false);
});

test('one unresolved continuation spends the entire buffering allowance', async () => {
	let sent = 0;
	const body = new ReadableStream({
		start(out) { out.enqueue('prefix'); },
		async pull(out) { await turn(); if (sent++ < 3) out.enqueue('x'); else out.close(); }
	}, { highWaterMark: 0 });
	const result = await collectImmediate(body);
	assert.equal(result.complete, false);
	assert.ok(sent < 3);
	assert.equal(await new Response(result.stream).text(), 'prefixxxx');
	assert.equal(body.locked, false);
});

test('byte-cap continuation normalizes later typed views and strings without losing the pending read', async () => {
	const array = Uint8Array.from([99, 65, 66, 99]);
	const body = stream(['abcd', new DataView(array.buffer, 1, 2), 'tail']);
	const result = await collectImmediate(body, undefined, 3);
	assert.equal(result.complete, false);
	assert.equal(await new Response(result.stream).text(), 'abcdABtail');
	assert.equal(body.locked, false);
});

test('invalid buffered chunks cancel and release the source', async () => {
	let cancelled = false;
	const body = new ReadableStream({ start(out) { out.enqueue(3); }, cancel() { cancelled = true; } });
	await assert.rejects(collectImmediate(body), /Response body chunks/);
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
});

test('cancel releases a pending response reader without waiting for source cancellation', async () => {
	let cancelled = false;
	const body = new ReadableStream({ start(out) { out.enqueue('prefix'); }, cancel() { cancelled = true; return new Promise(() => {}); } });
	const result = await collectImmediate(body);
	assert.equal(result.complete, false);
	await result.stream.cancel();
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
});


test('direct responses stream after the second ready chunk', async () => {
 const body = new ReadableStream({ start(out) { out.enqueue('first'); out.enqueue('second'); out.close(); } });
 const result = await collectImmediate(body, undefined, Infinity, 2);
 assert.equal(result.complete, false);
 assert.equal(await new Response(result.stream).text(), 'firstsecond');
});

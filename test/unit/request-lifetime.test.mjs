import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImmediate } from '../../src/runtime/handler/response-collect.js';
import { openRequestLifetime } from '../../src/runtime/handler/request-lifetime.js';
import { requestSignals, counters } from '../../src/runtime/handler/state.js';
import { abortInFlightRequests, drain } from '../../src/runtime/handler/lifecycle.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function open(method = 'GET', body) {
	const transport = new AbortController();
	const native = new Request('http://localhost/route', { method, body, signal: transport.signal, duplex: 'half' });
	const lifetime = openRequestLifetime(native);
	return { transport, lifetime, request: lifetime.request(native.url) };
}

test('pending bodyless requests abort on disconnect and release once after response', async () => {
	const { transport, lifetime, request } = open();
	transport.abort();
	assert.equal(request.signal.aborted, true);
	assert.equal(request.signal.reason.name, 'AbortError');
	assert.equal(requestSignals.size, 1);
	const response = lifetime.response(new Response('done'));
	await response.text();
	lifetime.finish();
	assert.equal(requestSignals.size, 0);
	assert.equal(counters.inFlightCount, 0);
});

test('complete POST arrival stops disconnect aborts even before the app consumes it', async () => {
	let body;
	const { transport, lifetime, request } = open('POST', new ReadableStream({ start(out) { body = out; } }));
	body.enqueue(new TextEncoder().encode('abc'));
	body.close();
	await turn();
	transport.abort();
	assert.equal(request.signal.aborted, false);
	assert.equal(await request.text(), 'abc');
	await lifetime.response(new Response('ok')).text();
	assert.equal(requestSignals.size, 0);
});

test('incomplete POST disconnect aborts its signal and rejects the body reader', async () => {
	let body;
	const { transport, lifetime, request } = open('POST', new ReadableStream({ start(out) { body = out; } }));
	body.enqueue(new TextEncoder().encode('abc'));
	const reading = request.text();
	const rejected = assert.rejects(reading, error => error.constructor === Error && error.message === 'Request aborted');
	transport.abort();
	await rejected;
	assert.equal(request.signal.reason.name, 'AbortError');
	lifetime.finish();
	assert.equal(counters.inFlightCount, 0);
});

test('finished responses detach native abort and keep the application signal live', async () => {
	const { transport, lifetime, request } = open();
	await lifetime.response(new Response('done')).text();
	transport.abort();
	assert.equal(request.signal.aborted, false);
	assert.equal(requestSignals.size, 0);
});

test('drain waits through streaming completion and cancellation', async () => {
	const first = open();
	let body;
	const response = first.lifetime.response(new Response(new ReadableStream({ start(out) { body = out; } })));
	let drained = false;
	const waiting = drain().then(() => { drained = true; });
	await turn();
	assert.equal(drained, false);
	body.close();
	await response.text();
	await waiting;
	assert.equal(drained, true);
	const second = open();
	const held = second.lifetime.response(new Response(new ReadableStream()));
	await held.body.cancel();
	assert.equal(second.request.signal.aborted, true);
	assert.equal(counters.inFlightCount, 0);
});

test('response stream failure aborts the application signal and releases drain ownership', async () => {
	const { lifetime, request } = open();
	const response = lifetime.response(new Response(new ReadableStream({ pull() { throw new Error('stream failed'); } })));
	await assert.rejects(response.text(), /stream failed/);
	assert.equal(request.signal.aborted, true);
	assert.equal(counters.inFlightCount, 0);
});

test('shutdown aborts every remaining request with its named reason', () => {
	const { lifetime, request } = open();
	abortInFlightRequests();
	assert.equal(request.signal.reason.name, 'AbortError');
	assert.equal(request.signal.reason.message, 'The server shut down before the request finished');
	assert.equal(requestSignals.size, 0);
	lifetime.finish();
	assert.equal(counters.inFlightCount, 0);
});


test('native streaming disconnect cancels source and releases drain without Bun cancellation', async () => {
	const { transport, lifetime, request } = open();
	let cancelled = false;
	const response = lifetime.response(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
	const reading = response.body.getReader().read();
	transport.abort();
	assert.equal((await reading).done, true);
	await turn();
	assert.equal(cancelled, true);
	assert.equal(request.signal.aborted, true);
	assert.equal(requestSignals.size, 0);
	assert.equal(counters.inFlightCount, 0);
});

for (const method of ['GET', 'HEAD']) {
	test(`${method} buffered response completion preserves original body and detaches abort`, async () => {
		const { transport, lifetime, request } = open(method);
		const response = new Response('done');
		assert.equal(lifetime.response(response, true), response);
		assert.equal(await response.text(), 'done');
		transport.abort();
		assert.equal(request.signal.aborted, false);
		assert.equal(counters.inFlightCount, 0);
	});
}


test('HEAD cancels streaming GET fallback without aborting application signal', async () => {
	const { lifetime, request } = open('HEAD');
	let cancelled = false;
	const response = lifetime.response(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
	assert.notEqual(response.body, null);
	assert.equal(await response.text(), '');
	await turn();
	assert.equal(cancelled, true);
	assert.equal(request.signal.aborted, false);
	assert.equal(requestSignals.size, 0);
	assert.equal(counters.inFlightCount, 0);
});


test('unread uploads stop pulling at a bounded byte window and resume without losing data', async () => {
	let produced = 0;
	const count = 256;
	const chunkSize = 16 * 1024;
	const source = new ReadableStream({
		pull(out) {
			if (produced === count) { out.close(); return; }
			out.enqueue(new Uint8Array(chunkSize).fill(produced++));
		}
	});
	const { transport, lifetime, request } = open('POST', source);
	await turn();
	assert.ok(produced <= 6, `read ${produced} chunks without application demand`);
	const received = new Uint8Array(await request.arrayBuffer());
	assert.equal(received.byteLength, count * chunkSize);
	for (let i = 0; i < count; i++) {
		assert.equal(received[i * chunkSize], i);
		assert.equal(received[(i + 1) * chunkSize - 1], i);
	}
	transport.abort();
	assert.equal(request.signal.aborted, false);
	lifetime.finish();
});

test('disconnect cancels an unread upload after its bounded window fills', async () => {
	let cancelled = false;
	const source = new ReadableStream({
		pull(out) { out.enqueue(new Uint8Array(16 * 1024)); },
		cancel() { cancelled = true; }
	});
	const { transport, lifetime, request } = open('POST', source);
	await turn();
	const reader = request.body.getReader();
	const closed = assert.rejects(reader.closed, /Request aborted/);
	transport.abort();
	await closed;
	await assert.rejects(reader.read(), /Request aborted/);
	reader.releaseLock();
	await turn();
	assert.equal(cancelled, true);
	assert.equal(request.signal.aborted, true);
	lifetime.finish();
});


test('cancelling an incomplete application body does not signal transport completion', async () => {
	const { transport, lifetime, request } = open('POST', new ReadableStream());
	await turn();
	await request.body.cancel();
	transport.abort();
	assert.equal(request.signal.aborted, true);
	lifetime.finish();
});


test('native upload errors abort immediately while the application queue is full', async () => {
	let input;
	const source = new ReadableStream({
		start(out) { input = out; },
		pull(out) { out.enqueue(new Uint8Array(16 * 1024)); }
	});
	const { lifetime, request } = open('POST', source);
	await turn();
	const failure = new Error('transport failed');
	const reader = request.body.getReader();
	const closed = assert.rejects(reader.closed, error => error === failure);
	input.error(failure);
	await closed;
	assert.equal(request.signal.reason, failure);
	await assert.rejects(reader.read(), error => error === failure);
	reader.releaseLock();
	lifetime.finish();
});


test('completed POST disconnect releases a response reader whose cancel never settles', async () => {
	const { transport, lifetime, request } = open('POST', 'complete');
	assert.equal(await request.text(), 'complete');
	let cancelled = false;
	const source = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
	const response = lifetime.response(new Response(source));
	const reading = response.body.getReader().read();
	transport.abort();
	assert.equal((await reading).done, true);
	assert.equal(cancelled, true);
	assert.equal(source.locked, false);
	assert.equal(request.signal.aborted, false);
	assert.equal(counters.inFlightCount, 0);
});


test('disconnect before the first response byte cancels the owned collector and releases its reader', { timeout: 2000 }, async () => {
	for (const method of ['GET', 'POST']) {
		const { transport, lifetime, request } = open(method, method === 'POST' ? 'complete' : undefined);
		if (method === 'POST') assert.equal(await request.text(), 'complete');
		let cancelled = 0;
		const source = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
		const collecting = collectImmediate(source, lifetime);
		assert.equal(source.locked, true);
		transport.abort();
		const result = await collecting;
		assert.equal(result.complete, true);
		assert.equal(result.bytes.byteLength, 0);
		assert.equal(cancelled, 1);
		assert.equal(source.locked, false);
		assert.equal(request.signal.aborted, method === 'GET');
		lifetime.response(new Response(result.bytes), true);
		assert.equal(requestSignals.size, 0);
		assert.equal(counters.inFlightCount, 0);
	}
});


test('an already-disconnected request cancels collection without reading its released reader', { timeout: 2000 }, async () => {
	for (const method of ['GET', 'POST']) {
		const { transport, lifetime, request } = open(method, method === 'POST' ? 'complete' : undefined);
		if (method === 'POST') assert.equal(await request.text(), 'complete');
		transport.abort();
		let cancelled = 0;
		let pulls = 0;
		const source = new ReadableStream({
			pull() { pulls++; },
			cancel() { cancelled++; return new Promise(() => {}); }
		}, { highWaterMark: 0 });
		const result = await collectImmediate(source, lifetime);
		assert.equal(result.complete, true);
		assert.equal(result.bytes.byteLength, 0);
		assert.equal(pulls, 0);
		assert.equal(cancelled, 1);
		assert.equal(source.locked, false);
		assert.equal(request.signal.aborted, method === 'GET');
		lifetime.response(new Response(result.bytes), true);
		assert.equal(requestSignals.size, 0);
		assert.equal(counters.inFlightCount, 0);
	}
});


for (const method of ['arrayBuffer', 'bytes', 'blob', 'text', 'json']) {
 test(`late ${method} consumption returns a rejecting promise after disconnect`, async () => {
  const { transport, lifetime, request } = open('POST', new ReadableStream({ pull(out) { out.enqueue(new Uint8Array(16 * 1024)); } }));
  await turn();
  transport.abort();
  let reading;
  assert.doesNotThrow(() => { reading = request[method](); });
  assert.ok(reading instanceof Promise);
  await assert.rejects(reading, /Request aborted/);
  lifetime.finish();
 });
}


for (const prefix of [0, 1024]) {
 test(`disconnect during a pending native read preserves the late body error after ${prefix} bytes`, async () => {
  const source = new ReadableStream({ start(out) { if (prefix) out.enqueue(new Uint8Array(prefix)); } });
  const { transport, lifetime, request } = open('POST', source);
  await turn();
  transport.abort();
  await turn();
  let reading;
  assert.doesNotThrow(() => { reading = request.arrayBuffer(); });
  await assert.rejects(reading, /Request aborted/);
  lifetime.finish();
 });
}

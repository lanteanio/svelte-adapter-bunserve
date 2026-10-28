import assert from 'node:assert/strict';
import { connect } from 'node:net';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { openRequestLifetime } = await import('../../src/runtime/handler/request-lifetime.js');
const { requestSignals, counters } = await import('../../src/runtime/handler/state.js');
const records = new Map();
const server = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	async fetch(native) {
		const mode = new URL(native.url).pathname.slice(1);
		const lifetime = openRequestLifetime(native);
		const request = lifetime.request(native.url);
		const record = { request, lifetime };
		records.set(mode, record);
		if (mode === 'first') {
			const reader = request.body.getReader();
			record.first = await reader.read();
		}
		const held = new Promise(resolve => { record.release = resolve; });
		record.ready = true;
		await held;
		if (mode === 'late-reader') {
			const reader = request.body.getReader();
			const closed = assert.rejects(reader.closed, /Request aborted/);
			await assert.rejects(async () => { for (;;) { const next = await reader.read(); if (next.done) throw new Error('body unexpectedly completed'); } }, /Request aborted/);
			await closed;
			record.rejected = true;
		}
		if (mode.startsWith('late-buffer')) {
			try { let pending; assert.doesNotThrow(() => { pending = request.arrayBuffer(); }); assert.ok(pending instanceof Promise); record.value = await pending; }
			catch (error) { record.error = error; }
		}
		return lifetime.response(new Response('done'), true);
	}
});
async function until(predicate, label) {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, `${label}: inFlight=${counters.inFlightCount}`);
		await new Promise(resolve => setImmediate(resolve));
	}
}
try {
	for (const mode of ['unread', 'first', 'late-reader', 'late-buffer', 'late-buffer-small']) {
		const socket = connect(server.port, '127.0.0.1');
		socket.on('error', () => {});
		await new Promise(resolve => socket.once('connect', resolve));
		socket.write(`POST /${mode} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8388608\r\n\r\n`);
		await new Promise(resolve => socket.write(Buffer.alloc(mode === 'late-buffer-small' ? 1024 : 256 * 1024, 120), resolve));
		await until(() => records.get(mode)?.ready, `${mode} ready`);
		const record = records.get(mode);
		if (mode === 'first') assert.ok(record.first.value.byteLength > 0);
		socket.destroy();
		await until(() => record.request.signal.aborted, `${mode} abort`);
		assert.equal(record.request.signal.reason.name, 'AbortError');
		// Leave a full turn for an unobserved rejection to terminate this worker.
		await new Promise(resolve => setImmediate(resolve));
		record.release();
		await until(() => counters.inFlightCount === 0, `${mode} released`);
		assert.equal(requestSignals.size, 0);
		if (mode === 'late-reader') assert.equal(record.rejected, true);
		if (mode.startsWith('late-buffer')) assert.equal(record.error?.message, 'Request aborted', `late body value=${record.value?.byteLength}, error=${record.error}`);
		console.log(`${mode} upload disconnect survived`);
	}
} finally {
	for (const record of records.values()) record.release?.();
	server.stop(true);
}

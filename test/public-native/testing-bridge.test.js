import { afterEach, expect, it, spyOn } from 'bun:test';
import { App } from '../../src/runtime/testing-bun.js';

let listener;
afterEach(() => { listener?.close(); listener = null; });
async function listen(app) {
	listener = await new Promise(resolve => app.listen(0, resolve));
	expect(listener).toBeTruthy();
	return `http://127.0.0.1:${listener.port}`;
}

it('streams request bytes through onData and marks the final callback', async () => {
	const chunks = [];
	let finalCalls = 0;
	const app = App().any('/body', response => {
		response.onData((chunk, last) => {
			chunks.push(Buffer.from(chunk));
			if (last) { finalCalls++; response.end(Buffer.concat(chunks)); }
		});
	});
	const url = await listen(app);
	const expected = new Uint8Array(200000).map((_, index) => index % 251);
	const result = await fetch(url + '/body', { method: 'POST', body: expected });
	expect(new Uint8Array(await result.arrayBuffer())).toEqual(expected);
	expect(finalCalls).toBe(1);
});

it.each([204, 304])('strips forbidden response bytes at status %s', async status => {
	const url = await listen(App().any('/empty', response => response.writeStatus(String(status)).end('forbidden')));
	const response = await fetch(url + '/empty');
	expect(response.status).toBe(status);
	expect(await response.text()).toBe('');
});

it('forwards drain, native limits and no-status close through one facade', () => {
	let callbacks;
	let opened;
	let drained;
	let closeCode;
	const serve = spyOn(Bun, 'serve').mockImplementation(options => {
		callbacks = options;
		return { port: 12345, stop() {} };
	});
	try {
		App().ws('/ws', {
			maxPayloadLength: 65536, idleTimeout: 17, sendPingsAutomatically: false,
			open(socket) { opened = socket; }, drain(socket) { drained = socket; },
			close(_socket, code) { closeCode = code; }
		}).listen(0, value => { listener = value; });
		expect(callbacks.websocket.maxPayloadLength).toBe(65536);
		expect(callbacks.websocket.idleTimeout).toBe(17);
		expect(callbacks.websocket.sendPings).toBe(false);
		const socket = { data: {}, readyState: 1, close() {}, terminate() {} };
		callbacks.websocket.open(socket);
		callbacks.websocket.drain(socket);
		expect(drained).toBe(opened);
		opened.end();
		callbacks.websocket.close(socket, 1005, '');
		expect(closeCode).toBe(0);
		expect(() => opened.getUserData()).toThrow();
	} finally { serve.mockRestore(); }
});

it('maps an aborted HTTP request to its abort callback and 499', async () => {
	let callbacks;
	let aborted = 0;
	const serve = spyOn(Bun, 'serve').mockImplementation(options => {
		callbacks = options;
		return { port: 12345, stop() {} };
	});
	try {
		App().any('/pending', response => response.onAborted(() => { aborted++; }))
			.listen(0, value => { listener = value; });
		const controller = new AbortController();
		const response = callbacks.fetch(new Request('http://localhost/pending', { signal: controller.signal }), { requestIP: () => null });
		controller.abort();
		expect((await response).status).toBe(499);
		expect(aborted).toBe(1);
	} finally { serve.mockRestore(); }
});

// What the dev plugin's HTTP middlewares read off a request, held to what
// production reads. Vite's connect matches a mount without regard to case and
// with anything after a `/` or `.`, and strips it from `req.url`; with
// `server.https` set, Vite serves HTTP/2, whose compatibility request carries
// the pseudo-headers and `:authority` in place of `host`, over TLS that Vite
// terminates. Production routes the exact path and reads the target as the
// client sent it.
//
// Both surfaces run the fixture's own authenticate hook, whose echo lane
// answers with the event it was handed, and each is held to the same literal
// expectations, so the production arm is what shows those are production's.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as http2Connect, constants as http2Constants, Http2ServerResponse } from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { authRequestBody } from '../../src/vite-request-body.js';
import { bootViteDev, APP_STATUS } from '../helpers/vite-dev.js';
import { findOpenssl, loopbackCertificate } from '../helpers/openssl.js';
import { authenticate } from '../helpers/vite-auth-hook.js';
import { authenticate as budgetAuthenticate } from '../helpers/vite-body-budget-hook.js';
import adapter from '../../src/index.js';

/** Targets production routes to the hook, and the `url` the hook is handed. */
const ROUTED = [
	['/__ws/auth', '/__ws/auth'],
	['/__ws/auth?a=1&b=%20', '/__ws/auth?a=1&b=%20'],
	['/__ws/auth?a', '/__ws/auth?a'],
	// The path ends at the first `?`.
	['/__ws/auth?next=/a?b', '/__ws/auth?next=/a?b'],
	// uWS reports an empty query as none.
	['/__ws/auth?', '/__ws/auth']
];

/** Spellings Vite's connect mounts onto the path and production does not route. */
const NOT_ROUTED = ['/__ws/auth/', '/__ws/auth/x', '/__WS/AUTH', '/__ws/Auth', '/__ws/auth.json', '/__ws/auth.'];

/**
 * The fixture's declared-length lanes: the status each answers, and the length
 * on the wire, which is the body's own unless a 304 declares one.
 */
const DECLARED_LENGTHS = [
	['declared-body', 200, '5'],
	['declared-empty', 200, '0'],
	['declared-204', 204, undefined],
	['304', 304, '42'],
	['304-loose', 304, '42']
];

/**
 * The start of the cookie the fixture's non-ASCII lane sets, and on its
 * Response the header value and the Set-Cookie.
 */
const NON_ASCII_COOKIE = '\u2603=v; Path=/\u2641';
const NON_ASCII_TEXT = '\u00e9';
const NON_ASCII_RESPONSE_COOKIE = 'a=\u00e9';

/**
 * The fixture's non-ASCII lane, checked on an answer's headers.
 *
 * @param {string} lane
 * @param {Record<string, any>} headers
 */
function expectNonAscii(lane, headers) {
	const cookies = [].concat(headers['set-cookie'] ?? []);
	const cookie = cookies.find((c) => c.startsWith(asWire(NON_ASCII_COOKIE.slice(0, 2))));
	expect(cookie?.slice(0, asWire(NON_ASCII_COOKIE).length), lane).toBe(asWire(NON_ASCII_COOKIE));
	if (lane !== 'response') return;
	expect(headers['x-text']).toBe(NON_ASCII_TEXT);
	expect(cookies).toContain(NON_ASCII_RESPONSE_COOKIE);
}

/**
 * Text as a client reads its UTF-8 bytes off the wire: node's clients decode
 * header bytes one character each.
 *
 * @param {string} text
 */
const asWire = (text) => Buffer.from(text, 'utf8').toString('latin1');

/** The Date the fixture's broken-body Response carries, and this file's lanes. */
const HOOK_DATE = 'Mon, 01 Jan 2001 00:00:00 GMT';

/** A Response reporting a status its constructor would refuse. */
class StatusResponse extends Response {
	/**
	 * @param {number} status
	 * @param {BodyInit | null} body
	 * @param {ResponseInit} init
	 */
	constructor(status, body, init) {
		super(body, init);
		this.reported = status;
	}

	get status() {
		return this.reported;
	}
}

/** Connection-specific response headers, including a nominated field. */
const CONNECTION_HEADERS = {
	// node's http2 layer throws only on this value; it drops any other.
	connection: 'trailers, X-Private',
	// Not node's own default, so a value it wrote itself does not pass.
	'keep-alive': 'timeout=7',
	'proxy-connection': 'keep-alive',
	'transfer-encoding': 'chunked',
	upgrade: 'h2c',
	'http2-settings': 'AAMAAABkAAQAAP__',
	te: 'gzip',
	trailer: 'x-sum',
	'x-private': 'hidden'
};

/** Fields the HTTP/1.1 transport does not generate itself. */
const NONFRAMING_CONNECTION_HEADERS = ['proxy-connection', 'upgrade', 'http2-settings', 'te', 'trailer', 'x-private'];

/**
 * The fixture's hook, with lanes of this file's own: a Response carrying the
 * HTTP/1.1 connection headers an app may pass on from an upstream fetch;
 * answers that carry something node's HTTP/1.1 writer refuses, before
 * writing (a header value, a Set-Cookie value, the status of
 * `Response.error()`, a cookie on the implicit 204); a trailer declaration
 * on a 204; a Response reporting a given status; and 304s
 * declaring a given length.
 */
const withOwnLanes = {
	/** @param {any} event */
	authenticate(event) {
		if (event.headers['x-cookie-hop'] === '1') {
			event.cookies.set('retained', 'visible', { path: '/' });
			return new Response(null, {
				status: 304,
				headers: { connection: 'Set-Cookie, Content-Length', 'set-cookie': 'hidden=secret', 'content-length': '123' }
			});
		}
		if (event.headers['x-connection-headers'] === '1') {
			return new Response('kept', { headers: { ...CONNECTION_HEADERS, 'x-kept': '1' } });
		}
		switch (event.headers['x-refused']) {
			// The Responses with headers carry the hook's own Date too: a 500
			// that has node's Date shows the refusal came before anything was
			// set.
			case 'value':
				return new Response('written', { headers: { 'a-first': '1', date: HOOK_DATE, 'x-refused': 'a\u0001b' } });
			case 'set-cookie':
				return new Response('written', { headers: { 'a-first': '1', date: HOOK_DATE, 'set-cookie': 'sid=a\u0001b' } });
			case 'status':
				event.cookies.set('hook_session', 'secret', { path: '/' });
				return Response.error();
			// The implicit 204, with a cookie whose Expires is not a Date's.
			case 'implicit-expires':
				event.cookies.set('hook_session', 'secret', { path: '/', expires: { toUTCString: () => 'x\u0001y' } });
				return undefined;
			// Refused only as the response is written: node chunks no 204.
			case 'trailer':
				event.cookies.set('hook_session', 'secret', { path: '/' });
				return new Response(null, { status: 204, headers: { 'a-first': '1', trailer: 'x-sum' } });
		}
		if (event.headers['x-status'] !== undefined) {
			return new StatusResponse(Number(event.headers['x-status']), 'written', { headers: { 'a-first': '1', date: HOOK_DATE } });
		}
		if (event.headers['x-304-length'] !== undefined) {
			return new Response(null, { status: 304, headers: { 'content-length': event.headers['x-304-length'] } });
		}
		return authenticate(event);
	}
};

/**
 * A POST, or another method, over HTTP/1.1.
 *
 * @param {number} port
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 */
function send(port, path, { method = 'POST', headers = { 'x-requested-with': 'XMLHttpRequest', 'x-auth-echo': '1' } } = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path,
			method,
			headers: { ...headers, 'content-length': '0' }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => resolve({
				status: res.statusCode,
				headers: res.headers,
				echoed: res.headers['x-auth-echo'] === '1',
				body
			}));
		});
		req.once('error', reject);
		req.end();
	});
}

/**
 * An auth POST over HTTP/1.1 declaring a body of `size` bytes and sending
 * `sent` of them; it ends the body only when it sends all of it.
 *
 * @param {number} port
 * @param {number} size
 * @param {number} [sent]
 * @param {Record<string, string>} [headers]
 */
function postBody(port, size, sent = size, headers = { 'x-requested-with': 'XMLHttpRequest' }) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { ...headers, 'content-length': String(size) }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => {
				if (sent < size) req.destroy();
				resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body });
			});
		});
		req.once('error', (err) => { if (sent === size) reject(err); });
		req.setTimeout(2000, () => { req.destroy(); reject(new Error('Auth response timed out')); });
		if (sent === size) req.end('x'.repeat(size));
		else req.write('x'.repeat(sent));
	});
}

/**
 * An auth POST over HTTP/1.1 whose body of `size` bytes goes out chunked, with
 * no declared length, optionally asking the fixture's hook to read it.
 *
 * @param {number} port
 * @param {number} size
 * @param {boolean} [read]
 */
function postChunked(port, size, read = true) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { 'x-requested-with': 'XMLHttpRequest', ...(read ? { 'x-auth-read-body': '1' } : {}) }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body }));
		});
		req.once('error', reject);
		for (let sent = 0; sent < size; sent += 16 * 1024) req.write('x'.repeat(Math.min(16 * 1024, size - sent)));
		req.end();
	});
}

/**
 * One HTTP/2 exchange on a fresh session, over TLS when given the certificate
 * to trust.
 *
 * @param {number} port
 * @param {Record<string, string>} headers
 * @param {string} [ca]
 * @param {string} [body]
 */
function h2Exchange(port, headers, ca, body) {
	return new Promise((resolve, reject) => {
		const session = ca === undefined
			? http2Connect(`http://127.0.0.1:${port}`)
			: http2Connect(`https://127.0.0.1:${port}`, { ca });
		/** @param {Error} err */
		const fail = (err) => { session.destroy(); reject(err); };
		session.once('error', fail);
		const stream = session.request(headers);
		/** @type {Record<string, any>} */
		let responseHeaders = {};
		let received = '';
		stream.setEncoding('utf8');
		stream.once('response', (h) => { responseHeaders = h; });
		stream.on('data', (chunk) => { received += chunk; });
		stream.once('error', fail);
		// On close rather than on the response's end: a stream the server
		// never completes leaves the case waiting.
		stream.once('close', () => {
			session.close();
			resolve({ status: responseHeaders[':status'], headers: responseHeaders, body: received });
		});
		stream.end(body);
	});
}

/**
 * The status a WebSocket handshake gets: 101 when it opens.
 *
 * @param {string} url
 * @param {string} origin
 * @param {string} [ca]
 */
function openWebSocket(url, origin, ca) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, ca === undefined ? { origin } : { origin, ca });
		ws.once('open', () => { ws.terminate(); resolve(101); });
		ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
		ws.once('error', reject);
	});
}

/**
 * Boot the plugin with ORIGIN unset, so the same-origin rule reads the request.
 *
 * @param {Parameters<typeof bootViteDev>[0]} options
 */
async function bootWithoutOrigin(options) {
	const saved = process.env.ORIGIN;
	delete process.env.ORIGIN;
	try {
		return await bootViteDev(options);
	} finally {
		if (saved !== undefined) process.env.ORIGIN = saved;
	}
}

/** The bound on an answer held for the rest of its body, on both surfaces. */
const WAIT_LIMIT_MS = 10000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A macrotask, then a poll: an answer the server had written would have
// reached a loopback client by now.
const settleTurn = async () => { await new Promise((resolve) => setImmediate(resolve)); await pause(50); };

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
async function until(predicate, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('The condition was never met');
		await pause(5);
	}
}

/**
 * A raw HTTP/1.1 connection, and what came back on it.
 *
 * @param {number} port
 */
async function wire(port) {
	const socket = netConnect(port, '127.0.0.1');
	const conn = { socket, text: '', closed: false };
	socket.on('data', (data) => { conn.text += data.toString('latin1'); });
	socket.on('error', () => {});
	socket.on('close', () => { conn.closed = true; });
	await once(socket, 'connect');
	return conn;
}

/** @param {string} text */
const headerBlock = (text) => text.slice(0, text.indexOf('\r\n\r\n'));

/** @param {number} size */
const chunk = (size) => size.toString(16) + '\r\n' + 'x'.repeat(size) + '\r\n';

/**
 * The runtime timer seam of the module graph a surface runs: timers of
 * `ms` are held back for the case to fire, every other timer runs.
 *
 * @param {string} runtimeUrl
 * @param {number} ms
 * @param {(held: Set<{ fire: () => void }>) => Promise<void>} run
 */
async function withHeldTimers(runtimeUrl, ms, run) {
	const runtime = await import(runtimeUrl);
	/** @type {Set<{ fire: () => void }>} */
	const held = new Set();
	runtime.setRuntimeEnv({ timers: {
		/**
		 * @param {(...args: any[]) => void} callback
		 * @param {number} delay
		 * @param {...any} args
		 */
		set: (callback, delay, ...args) => {
			if (delay !== ms) return setTimeout(callback, delay, ...args);
			const timer = { fire: () => { held.delete(timer); callback(...args); } };
			held.add(timer);
			return timer;
		},
		/** @param {any} timer */
		clear: (timer) => { if (!held.delete(timer)) clearTimeout(timer); }
	} });
	try { await run(held); } finally { runtime.resetRuntimeEnv(); }
}

/**
 * Refusals of the auth endpoint answered before any body is read: the case,
 * the request line, header fields beyond Host, and the status.
 *
 * @type {Array<[string, string, Record<string, string>, number]>}
 */
const REFUSALS = [
	['a method other than POST', 'GET /__ws/auth', {}, 405],
	['a preflight', 'OPTIONS /__ws/auth', { origin: 'https://other.example', 'access-control-request-method': 'POST' }, 405],
	['a Host that is not an authority', 'POST /__ws/auth', { 'x-requested-with': 'XMLHttpRequest', host: 'a/other?' }, 400],
	['a target with a fragment', 'POST /__ws/auth#x', { 'x-requested-with': 'XMLHttpRequest' }, 400]
];

/**
 * A refusal answered before the body is read: with a body still coming,
 * declared or chunked, it closes the connection; without one it keeps it.
 *
 * @param {number} port
 * @param {string} line
 * @param {Record<string, string>} extra
 * @param {number} status
 */
async function expectRefusalCloses(port, line, extra, status) {
	for (const framing of ['content-length: 5', 'transfer-encoding: chunked', null]) {
		const conn = await wire(port);
		try {
			const fields = { host: `127.0.0.1:${port}`, ...extra };
			const head = line + ' HTTP/1.1\r\n' + Object.entries(fields).map(([k, v]) => k + ': ' + v + '\r\n').join('') +
				(framing === null ? '' : framing + '\r\n') + '\r\n';
			// A body still on its way: only part of it is sent.
			conn.socket.write(head + (framing === null ? '' : framing.startsWith('content') ? 'ab' : '2\r\nab\r\n'));
			await until(() => conn.text.includes('\r\n\r\n'));
			expect(conn.text.slice(0, 12), String(framing)).toBe('HTTP/1.1 ' + status);
			const connection = headerBlock(conn.text).match(/^connection:.*$/gim)?.map((h) => h.toLowerCase());
			if (framing === null) {
				expect(connection ?? ['connection: keep-alive'], 'no body').toEqual(['connection: keep-alive']);
				await settleTurn();
				expect(conn.closed, 'no body').toBe(false);
			} else {
				expect(connection, String(framing)).toEqual(['connection: close']);
				await until(() => conn.closed);
			}
		} finally { conn.socket.destroy(); }
	}
}

// The same-origin rule, which the default production fixture relaxes to any
// origin, on both surfaces.
const SAME_ORIGIN_SURFACES = [
	{
		label: 'vite dev',
		boot: () => bootWithoutOrigin({ handler: { authenticate } })
	}
];

for (const surface of SAME_ORIGIN_SURFACES) {
	describe(`the auth endpoint's origin refusal on ${surface.label}`, () => {
		/** @type {{ port: number, close: () => Promise<void> }} */
		let server;
		beforeAll(async () => { server = await surface.boot(); }, 400_000);
		afterAll(async () => { await server?.close(); });

		it('closes the connection behind a refused origin only while a body is coming', async () => {
			for (const extra of [{ origin: 'https://other.example' }, {}, { 'sec-fetch-site': 'cross-site' }]) {
				await expectRefusalCloses(server.port, 'POST /__ws/auth', extra, 403);
			}
		});
	});
}

const SURFACES = [
	{
		label: 'vite dev',
		runtimeUrl: new URL('../../src/runtime/runtime.js', import.meta.url).href,
		boot: () => bootWithoutOrigin({ handler: { authenticate } })
	}
];

for (const surface of SURFACES) {
	describe(`the auth endpoint's target on ${surface.label}`, () => {
		/** @type {{ port: number, close: () => Promise<void> }} */
		let server;
		beforeAll(async () => { server = await surface.boot(); }, 120_000);
		afterAll(async () => { await server?.close(); });

		it('hands the hook the target as the client sent it', async () => {
			for (const [target, url] of ROUTED) {
				const res = await send(server.port, target);
				expect(res.status, target).toBe(200);
				expect(res.echoed, target).toBe(true);
				const event = JSON.parse(res.body);
				expect(event.url, target).toBe(url);
				expect(event.requestUrl, target).toBe(`http://127.0.0.1:${server.port}${url}`);
			}
		});

		it('routes the exact path only', async () => {
			for (const target of NOT_ROUTED) {
				const res = await send(server.port, target);
				expect(res.echoed, target).toBe(false);
				// The request went on to the application.
				if (surface.label === 'vite dev') expect(res.status, target).toBe(APP_STATUS);
			}
			expect((await send(server.port, '/__ws/auth', { method: 'GET' })).status).toBe(405);
			const otherGet = await send(server.port, '/__WS/AUTH', { method: 'GET' });
			expect(otherGet.status).not.toBe(405);
			if (surface.label === 'vite dev') expect(otherGet.status).toBe(APP_STATUS);
		});

		it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://other.example'])('refuses auth preflight from %s', async (origin) => {
			for (const [target] of ROUTED) {
				const response = await send(server.port, target, {
					method: 'OPTIONS',
					headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with' }
				});
				expect(response.status, target).toBe(405);
				expect(response.headers.allow, target).toBe('POST');
				expect(response.headers['access-control-allow-origin'], target).toBeUndefined();
				expect(response.headers['access-control-allow-credentials'], target).toBeUndefined();
				expect(response.echoed, target).toBe(false);
			}
		});

		it('answers a declared body past 64 KiB with 413, and takes one of 64 KiB', async () => {
			const over = await postBody(server.port, 64 * 1024 + 1);
			expect(over.status).toBe(413);
			expect(over.statusMessage).toBe('Content Too Large');
			expect(over.headers['content-type']).toBe('text/plain');
			expect(over.body).toBe('Content Too Large');
			expect(over.headers.connection).toBe('close');
			expect((await postBody(server.port, 64 * 1024)).status).toBe(204);
		});

		it('answers a body past 64 KiB sent without a declared length with 413', async () => {
			const res = await postChunked(server.port, 70 * 1024);
			expect(res.status).toBe(413);
			expect(res.body).toBe('Content Too Large');
			const within = await postChunked(server.port, 1024);
			expect(within.status).toBe(204);
			// The hook reads the body it was sent.
			expect(within.headers['x-body-length']).toBe('1024');
		});

		it('counts the bytes of an undeclared body the hook does not read, and refuses one past 64 KiB', async () => {
			const res = await postChunked(server.port, 70 * 1024, false);
			expect(res.status).toBe(413);
			expect(res.body).toBe('Content Too Large');
			expect(res.headers.connection).toBe('close');
		});

		// The held answer arms its wait, so the case knows the answer is held
		// rather than slow.
		it('holds the answer to an ignored declared body until the rest of it arrives', async () => {
			await withHeldTimers(surface.runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
				const before = new Set(waits);
				const conn = await wire(server.port);
				try {
					conn.socket.write(`POST /__ws/auth HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Requested-With: XMLHttpRequest\r\nContent-Length: ${64 * 1024}\r\n\r\n` + 'x'.repeat(10));
					await until(() => [...waits].some((t) => !before.has(t)));
					await settleTurn();
					expect(conn.text).toBe('');
					conn.socket.write('x'.repeat(64 * 1024 - 10));
					await until(() => conn.text.includes('\r\n\r\n'));
					expect(conn.text.slice(0, 12)).toBe('HTTP/1.1 204');
					await settleTurn();
					expect(conn.closed).toBe(false);
				} finally { conn.socket.destroy(); }
			});
		});

		it('closes the connection behind an answer to an ignored undeclared body still coming', async () => {
			const conn = await wire(server.port);
			try {
				conn.socket.write(`POST /__ws/auth HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Requested-With: XMLHttpRequest\r\nX-Auth-Response: date\r\nTransfer-Encoding: chunked\r\n\r\n` + chunk(512));
				await until(() => conn.text.includes('dated'));
				expect(conn.text.slice(0, 12)).toBe('HTTP/1.1 200');
				expect(headerBlock(conn.text).match(/^connection:.*$/gim)?.map((h) => h.toLowerCase())).toEqual(['connection: close']);
				await until(() => conn.closed);
			} finally { conn.socket.destroy(); }
		});

		it.each(REFUSALS)('closes the connection behind a refusal of %s only while a body is coming', async (_case, line, extra, status) => {
			await expectRefusalCloses(server.port, line, extra, status);
		});

		it('drops the implicit 204, with its connection, once the rest of an ignored body stops coming', async () => {
			await withHeldTimers(surface.runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
				const before = new Set(waits);
				const conn = await wire(server.port);
				try {
					conn.socket.write(`POST /__ws/auth HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Requested-With: XMLHttpRequest\r\nContent-Length: 1000\r\n\r\n` + 'x'.repeat(10));
					await until(() => [...waits].some((t) => !before.has(t)));
					const wait = /** @type {{ fire: () => void }} */ ([...waits].find((t) => !before.has(t)));
					await settleTurn();
					expect(conn.text).toBe('');
					expect(conn.closed).toBe(false);
					wait.fire();
					await until(() => conn.closed);
					expect(conn.text).toBe('');
				} finally { conn.socket.destroy(); }
			});
		});

		// The wait is measured in what the client delivers: 160 KiB per period
		// starts the next one. Under the 64 KiB cap the whole rest of a body is
		// less than that, so its period is never restarted.
		it('keeps the period of a held answer for a rest short of 160 KiB, and answers once it has arrived', async () => {
			await withHeldTimers(surface.runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
				const before = new Set(waits);
				const conn = await wire(server.port);
				try {
					conn.socket.write(`POST /__ws/auth HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Requested-With: XMLHttpRequest\r\nTransfer-Encoding: chunked\r\n\r\n` + chunk(512));
					await until(() => [...waits].some((t) => !before.has(t)));
					const wait = /** @type {{ fire: () => void }} */ ([...waits].find((t) => !before.has(t)));
					conn.socket.write(chunk(60 * 1024));
					await settleTurn();
					expect(waits.has(wait)).toBe(true);
					expect(conn.text).toBe('');
					conn.socket.write('0\r\n\r\n');
					await until(() => conn.text.startsWith('HTTP/1.1 204'));
					expect(waits.has(wait)).toBe(false);
					await settleTurn();
					expect(conn.closed).toBe(false);
				} finally { conn.socket.destroy(); }
			});
		});

		it('reads all 64 KiB of a body at the cap', async () => {
			const res = await postBody(server.port, 64 * 1024, undefined, {
				'x-requested-with': 'XMLHttpRequest', 'x-auth-read-body': '1'
			});
			expect(res.status).toBe(204);
			expect(res.headers['x-body-length']).toBe(String(64 * 1024));
		});

		it('answers a declared length past 64 KiB before the body arrives, after the Host check', async () => {
			const res = await postBody(server.port, 64 * 1024 + 1, 10);
			expect(res.status).toBe(413);
			// A Host that is not an authority is refused first, as production
			// refuses it before it looks at the length.
			const badHost = await postBody(server.port, 1024 * 1024, 10, { 'x-requested-with': 'XMLHttpRequest', host: 'a/other?' });
			expect(badHost.status).toBe(400);
		});

		it('answers a hook Response whose body fails with a 500 that carries none of its headers', async () => {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-broken-body': '1' }
			});
			expect(res.status).toBe(500);
			expect(res.headers['set-cookie']).toBeUndefined();
			expect(res.headers['x-from-hook']).toBeUndefined();
			expect(res.headers.date).toBeDefined();
			expect(res.headers.date).not.toBe(HOOK_DATE);
		});

		it('preserves Response header bytes and encodes cookie serializer text as UTF-8', async () => {
			for (const [lane, status] of [['response', 200], ['implicit', 204]]) {
				const res = await send(server.port, '/__ws/auth', {
					headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-non-ascii': lane }
				});
				expect(res.status, lane).toBe(status);
				expectNonAscii(lane, res.headers);
			}
		});

		it('writes the body\'s own length, and the one a hook 304 declares', async () => {
			for (const [lane, status, length] of DECLARED_LENGTHS) {
				const res = await send(server.port, '/__ws/auth', {
					headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-response': lane }
				});
				expect(res.status, lane).toBe(status);
				expect(res.headers['content-length'], lane).toBe(length);
			}
		});
	});
}

/**
 * Run `boot` with an environment variable set, as the runtime and the dev
 * plugin both read it as they start.
 *
 * @template T
 * @param {string} name
 * @param {string} value
 * @param {() => Promise<T>} boot
 */
async function withEnv(name, value, boot) {
	const saved = process.env[name];
	process.env[name] = value;
	try {
		return await boot();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

// The auth cap below 64 KiB, by a bodyLimits rule on the path or by
// BODY_SIZE_LIMIT, on both surfaces.
const NARROWED = [
	{
		label: 'a bodyLimits rule',
		cap: 1024,

		dev: () => bootWithoutOrigin({
			handler: { authenticate: budgetAuthenticate },
			adapter: adapter({ bodyLimits: [{ path: '/__ws/auth', bytes: 1024 }] })
		})
	},
	// Under the adapter's envPrefix, which both surfaces read it with.
	{
		label: 'BODY_SIZE_LIMIT',
		cap: 2048,

		dev: () => withEnv('TEST_APP_BODY_SIZE_LIMIT', '2K', () => bootWithoutOrigin({
			handler: { authenticate },
			adapter: adapter({ envPrefix: 'TEST_APP_' })
		}))
	}
];

for (const narrowed of NARROWED) {
	const surfaces = [
		{ label: 'vite dev', boot: narrowed.dev }
	];
	for (const surface of surfaces) {
		describe(`the auth body cap under ${narrowed.label} on ${surface.label}`, () => {
			/** @type {{ port: number, close: () => Promise<void> }} */
			let server;
			beforeAll(async () => { server = await surface.boot(); }, 120_000);
			afterAll(async () => { await server?.close(); });

			it('answers a declared length past the cap with 413, and takes one at it', async () => {
				const over = await postBody(server.port, narrowed.cap + 1);
				expect(over.status).toBe(413);
				expect(over.headers.connection).toBe('close');
				const at = await postBody(server.port, narrowed.cap, undefined, {
					'x-requested-with': 'XMLHttpRequest', 'x-auth-read-body': '1'
				});
				expect(at.status).toBeLessThan(300);
			});

			it('answers an undeclared body past the cap with 413', async () => {
				const res = await postChunked(server.port, narrowed.cap + 1);
				expect(res.status).toBe(413);
				expect(res.body).toBe('Content Too Large');
			});
		});
	}
}

// A handler that exports no `authenticate`: production mounts no auth route.
const WITHOUT_AUTH_SURFACES = [
	{ label: 'vite dev', boot: () => bootWithoutOrigin({ handler: {} }) }
];

for (const surface of WITHOUT_AUTH_SURFACES) {
	describe(`the auth path without an authenticate hook on ${surface.label}`, () => {
		/** @type {{ port: number, close: () => Promise<void> }} */
		let server;
		beforeAll(async () => { server = await surface.boot(); }, 120_000);
		afterAll(async () => { await server?.close(); });

		// The same answer a preflight to any other path gets: the application's,
		// or under Vite that of its CORS middleware.
		it('answers a preflight as it answers one to another path', async () => {
			const preflight = { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST' } };
			const res = await send(server.port, '/__ws/auth', preflight);
			const elsewhere = await send(server.port, '/__ws/elsewhere', preflight);
			expect(res.status).not.toBe(405);
			expect(res.headers.allow).toBeUndefined();
			expect(res.status).toBe(elsewhere.status);
		});

		it.each(['POST', 'OPTIONS'])('still refuses a %s target with a fragment', async (method) => {
			const conn = await wire(server.port);
			try {
				conn.socket.write(`${method} /__ws/auth#x HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 0\r\n\r\n`);
				await until(() => conn.text.includes('\r\n\r\n'));
				expect(conn.text.slice(0, 12)).toBe('HTTP/1.1 400');
			} finally { conn.socket.destroy(); }
		});
	});
}

// Production mounts the route only for an `authenticate` that is a function.
describe('the dev auth path with an authenticate export that is not a function', () => {
	/** @type {{ port: number, close: () => Promise<void> }} */
	let server;
	beforeAll(async () => { server = await bootWithoutOrigin({ handler: { authenticate: /** @type {any} */ (true) } }); }, 120_000);
	afterAll(async () => { await server?.close(); });

	it('hands the preflight and the POST to the application', async () => {
		const options = { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST' } };
		const preflight = await send(server.port, '/__ws/auth', options);
		expect(preflight.status).not.toBe(405);
		expect(preflight.headers.allow).toBeUndefined();
		expect(preflight.status).toBe((await send(server.port, '/__ws/elsewhere', options)).status);
		expect((await send(server.port, '/__ws/auth')).status).toBe(APP_STATUS);
	});
});

describe('the dev plugin\'s BODY_SIZE_LIMIT', () => {
	it('refuses to start on a value that is not a size, as production does', async () => {
		await expect(withEnv('BODY_SIZE_LIMIT', 'lots', () => bootWithoutOrigin({ handler: { authenticate } })))
			.rejects.toThrow("Invalid BODY_SIZE_LIMIT: 'lots'");
	});
});

describe('the dev plugin over plain HTTP/1.1', () => {
	/** @type {{ port: number, close: () => Promise<void> }} */
	let server;
	beforeAll(async () => { server = await bootWithoutOrigin({ handler: withOwnLanes }); }, 120_000);
	afterAll(async () => { await server?.close(); });

	it('checks a same-origin Origin against http on the WebSocket and the auth POST', async () => {
		const authority = `127.0.0.1:${server.port}`;
		expect(await openWebSocket(`ws://${authority}/ws`, `http://${authority}`)).toBe(101);
		expect(await openWebSocket(`ws://${authority}/ws`, `https://${authority}`)).toBe(403);
		/** @param {string} origin */
		const post = (origin) => send(server.port, '/__ws/auth', { headers: { origin, 'x-auth-echo': '1' } });
		expect((await post(`http://${authority}`)).status).toBe(200);
		expect((await post(`https://${authority}`)).status).toBe(403);
	});

	it('answers what node cannot write with a 500 that carries nothing of the hook\'s', async () => {
		for (const lane of ['value', 'set-cookie', 'status', 'implicit-expires']) {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-refused': lane }
			});
			expect(res.status, lane).toBe(500);
			expect(res.headers['a-first'], lane).toBeUndefined();
			expect(res.headers['set-cookie'], lane).toBeUndefined();
			expect(res.headers.date, lane).toBeDefined();
			expect(res.headers.date, lane).not.toBe(HOOK_DATE);
		}
	});

	it('answers a status that is no final status node can write with that 500, and writes 999', async () => {
		for (const status of ['199', '1000', '200.5']) {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-status': status }
			});
			expect(res.status, status).toBe(500);
			expect(res.headers['a-first'], status).toBeUndefined();
			expect(res.headers.date, status).not.toBe(HOOK_DATE);
		}
		const highest = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-status': '999' }
		});
		expect(highest.status).toBe(999);
		expect(highest.body).toBe('written');
	});

	it('drops a trailer declaration on a bodyless response', async () => {
		const response = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-refused': 'trailer' }
		});
		expect(response.status).toBe(204);
		expect(response.headers.trailer).toBeUndefined();
		expect((await send(server.port, '/__ws/auth')).status).toBe(200);
	});

	it('writes no length for a 304 whose declared one does not read as a length', async () => {
		for (const [declared, length] of [['0', '0'], ['0x10', '0'], ['-1', undefined], ['99999999999999999999', undefined], ['abc', undefined]]) {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-304-length': declared }
			});
			expect(res.status, declared).toBe(304);
			expect(res.headers['content-length'], declared).toBe(length);
		}
	});

	it('refuses a cross-origin POST before it looks at the declared length', async () => {
		const res = await postBody(server.port, 1024 * 1024, 10, { origin: 'http://elsewhere.example' });
		expect(res.status).toBe(403);
	});

	it('keeps on the 500 the headers middleware ahead of the plugin set', async () => {
		// Vite's CORS middleware admits a localhost origin before the plugin runs.
		const res = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-broken-body': '1', origin: 'http://localhost:5173' }
		});
		expect(res.status).toBe(500);
		expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
	});

	it('drops nominated Response cookies and length but keeps separately serialized cookies', async () => {
		const res = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-cookie-hop': '1' }
		});
		expect(res.status).toBe(304);
		expect(res.headers['content-length']).toBeUndefined();
		expect(res.headers['set-cookie']).toHaveLength(1);
		expect(res.headers['set-cookie'][0]).toMatch(/^retained=visible;/);
	});

	it('strips a hook Response\'s connection headers over HTTP/1.1', async () => {
		const res = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-connection-headers': '1' }
		});
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		expect(res.headers['x-kept']).toBe('1');
		expect(res.headers.connection).not.toBe(CONNECTION_HEADERS.connection);
		expect(res.headers['keep-alive']).not.toBe(CONNECTION_HEADERS['keep-alive']);
		for (const name of NONFRAMING_CONNECTION_HEADERS) {
			expect(res.headers[name], name).toBeUndefined();
		}
	});
});

describe('the dev plugin over HTTP/2', () => {
	/** @type {{ port: number, h2Port: number, close: () => Promise<void> }} */
	let server;
	// Every reason phrase an HTTP/2 response is given, through the setter or
	// writeHead, across the whole block: HTTP/2 has no room for one.
	/** @type {string[]} */
	const statusMessages = [];
	const statusMessage = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Http2ServerResponse.prototype, 'statusMessage'));
	const writeHead = Http2ServerResponse.prototype.writeHead;
	beforeAll(async () => {
		Object.defineProperty(Http2ServerResponse.prototype, 'statusMessage', {
			...statusMessage,
			/** @param {string} value */
			set(value) {
				statusMessages.push(value);
				statusMessage.set?.call(this, value);
			}
		});
		/** @this {Http2ServerResponse} @param {any[]} args */
		Http2ServerResponse.prototype.writeHead = function (...args) {
			if (typeof args[1] === 'string') statusMessages.push(args[1]);
			return writeHead.apply(this, /** @type {any} */ (args));
		};
		server = /** @type {any} */ (await bootWithoutOrigin({ handler: withOwnLanes, h2: true }));
	}, 120_000);
	afterAll(async () => {
		Object.defineProperty(Http2ServerResponse.prototype, 'statusMessage', statusMessage);
		Http2ServerResponse.prototype.writeHead = writeHead;
		await server?.close();
		expect(statusMessages).toEqual([]);
	});

	it('runs the auth hook with no pseudo-headers and the authority as the host', async () => {
		const authority = `127.0.0.1:${server.h2Port}`;
		// A same-origin Origin, checked against the host the authority supplies.
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth?a=1',
			':authority': authority,
			origin: `http://${authority}`,
			'x-auth-echo': '1'
		});
		expect(res.status).toBe(200);
		expect(res.headers['x-auth-echo']).toBe('1');
		const event = JSON.parse(res.body);
		expect(event.url).toBe('/__ws/auth?a=1');
		expect(event.requestUrl).toBe(`http://${authority}/__ws/auth?a=1`);
		expect(event.headerNames.filter((name) => name.startsWith(':'))).toEqual([]);
		expect(event.headerNames).toContain('host');
	});

	it('takes the authority over a host header that disagrees with it', async () => {
		const authority = `127.0.0.1:${server.h2Port}`;
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': authority,
			host: 'other.example',
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-echo': '1'
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).requestUrl).toBe(`http://${authority}/__ws/auth`);
	});

	it('drops nominated Response cookies and length over HTTP/2 while retaining app cookies', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST', ':path': '/__ws/auth', ':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest', 'x-cookie-hop': '1'
		});
		expect(res.status).toBe(304);
		expect(res.headers['content-length']).toBeUndefined();
		expect(res.headers['set-cookie']).toHaveLength(1);
		expect(res.headers['set-cookie'][0]).toMatch(/^retained=visible;/);
	});

	it('writes a hook Response without the headers HTTP/2 does not carry', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-connection-headers': '1'
		});
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		expect(res.headers['x-kept']).toBe('1');
		for (const name of Object.keys(CONNECTION_HEADERS)) {
			expect(res.headers[name], name).toBeUndefined();
		}
	});

	it('answers a status that is no final status HTTP/2 can carry with a 500 that carries nothing of the hook\'s', async () => {
		// 700 is refused by node's HTTP/2 writer, 200.5 by the lane.
		for (const status of ['700', '200.5']) {
			const res = await h2Exchange(server.h2Port, {
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-status': status
			});
			expect(res.status, status).toBe(500);
			expect(res.headers['a-first'], status).toBeUndefined();
			expect(res.headers.date, status).not.toBe(HOOK_DATE);
		}
	});

	it('preserves Response header bytes and encodes cookie serializer text as UTF-8', async () => {
		for (const [lane, status] of [['response', 200], ['implicit', 204]]) {
			const res = await h2Exchange(server.h2Port, {
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-auth-non-ascii': lane
			});
			expect(res.status, lane).toBe(status);
			expectNonAscii(lane, res.headers);
		}
	});

	it('keeps the hook\'s answer when a header value or cookie is one HTTP/1.1 refuses', async () => {
		for (const [lane, status] of [['value', 200], ['set-cookie', 200]]) {
			const res = await h2Exchange(server.h2Port, {
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-refused': lane
			});
			expect(res.status, lane).toBe(status);
			if (status === 200) {
				expect(res.body, lane).toBe('written');
				expect(res.headers['a-first'], lane).toBe('1');
			}
		}
	});

	it('rejects a cookie whose Expires is not a Date over HTTP/2', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-refused': 'implicit-expires'
		});
		expect(res.status).toBe(500);
		expect(res.headers['set-cookie']).toBeUndefined();
	});

	it('answers 413 as the body crosses 64 KiB, before the client has sent it all', async () => {
		const status = await new Promise((resolve, reject) => {
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.once('error', reject);
			const stream = session.request({
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-auth-read-body': '1'
			});
			stream.once('error', () => {});
			stream.once('response', (headers) => {
				resolve(headers[':status']);
				session.destroy();
			});
			// More than the cap, and the stream left open.
			stream.write('x'.repeat(70 * 1024));
		});
		expect(status).toBe(413);
	});

	it('reads the authority from host when a request carries no :authority', async () => {
		const page = await h2Exchange(server.h2Port, { ':method': 'GET', ':path': '/__uws/dashboard', host: `localhost:${server.h2Port}` });
		expect(page.status).toBe(200);
		const auth = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			host: `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-echo': '1'
		});
		expect(auth.status).toBe(200);
		expect(JSON.parse(auth.body).requestUrl).toBe(`http://127.0.0.1:${server.h2Port}/__ws/auth`);
	});

	it('answers a body past 64 KiB with 413', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-read-body': '1'
		}, undefined, 'x'.repeat(4 * 1024 * 1024));
		expect(res.status).toBe(413);
	});

	it('answers a declared length past 64 KiB before the body arrives', async () => {
		const status = await new Promise((resolve, reject) => {
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.once('error', reject);
			const stream = session.request({
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'content-length': String(64 * 1024 + 1)
			});
			stream.once('error', () => {});
			stream.once('response', (headers) => {
				resolve(headers[':status']);
				session.destroy();
			});
			stream.write('x'.repeat(10));
		});
		expect(status).toBe(413);
	});

	it('answers a hook Response whose body fails with a 500 that carries none of its headers', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-broken-body': '1'
		});
		expect(res.status).toBe(500);
		expect(res.headers['set-cookie']).toBeUndefined();
		expect(res.headers['x-from-hook']).toBeUndefined();
		expect(res.headers.date).not.toBe(HOOK_DATE);
	});

	it('serves the dashboard to a loopback authority and refuses any other', async () => {
		const page = await h2Exchange(server.h2Port, {
			':method': 'GET',
			':path': '/__uws/dashboard',
			':authority': `localhost:${server.h2Port}`
		});
		expect(page.status).toBe(200);
		expect(page.headers['content-type']).toContain('text/html');

		const rebound = await h2Exchange(server.h2Port, {
			':method': 'GET',
			':path': '/__uws/dashboard',
			':authority': `attacker.example:${server.h2Port}`
		});
		expect(rebound.status).toBe(403);
		expect(rebound.body).toContain('loopback');

		// The authority is what names the host; a loopback host header beside
		// a foreign authority does not pass the gate.
		const beside = await h2Exchange(server.h2Port, {
			':method': 'GET',
			':path': '/__uws/dashboard',
			':authority': `attacker.example:${server.h2Port}`,
			host: `localhost:${server.h2Port}`
		});
		expect(beside.status).toBe(403);
	});
});

describe('the dev auth lane\'s body read', () => {
	/** @type {{ port: number, h2Port: number, close: () => Promise<void> }} */
	let server;
	/** @type {(value?: unknown) => void} */
	let release;
	let calls = 0;
	beforeAll(async () => {
		// The handler loads only once released, so a request waits before its
		// body is read and a client can leave at that point on purpose.
		const ready = new Promise((resolve) => { release = resolve; });
		server = /** @type {any} */ (await bootWithoutOrigin({
			handler: { authenticate() { calls++; } },
			ready,
			h2: true
		}));
	}, 120_000);
	afterAll(async () => { await server?.close(); });

	it('runs no hook for a client that left before its body was read, and keeps serving', async () => {
		const overHttp1 = httpRequest({
			host: '127.0.0.1',
			port: server.port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { 'x-requested-with': 'XMLHttpRequest', 'content-length': '100' }
		});
		overHttp1.once('error', () => {});
		overHttp1.write('x'.repeat(10));

		/** @param {(session: import('node:http2').ClientHttp2Session, stream: import('node:http2').ClientHttp2Stream) => void} leave */
		const leaveOverHttp2 = (leave) => {
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.once('error', () => {});
			const stream = session.request({
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest'
			});
			stream.once('error', () => {});
			stream.write('x'.repeat(10));
			return () => leave(session, stream);
		};
		const resetStream = leaveOverHttp2((_session, stream) => stream.close(http2Constants.NGHTTP2_CANCEL));
		const dropSession = leaveOverHttp2((session) => session.destroy());

		await new Promise((resolve) => setTimeout(resolve, 100));
		overHttp1.destroy();
		resetStream();
		dropSession();
		await new Promise((resolve) => setTimeout(resolve, 100));
		release();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(calls).toBe(0);

		const after = await send(server.port, '/__ws/auth', { headers: { 'x-requested-with': 'XMLHttpRequest' } });
		expect(after.status).toBe(204);
		expect(calls).toBe(1);
	});

	it('refuses a declared body past 64 KiB before the hook, and an ignored chunked one as it crosses the budget', async () => {
		release();
		const before = calls;
		expect((await postBody(server.port, 64 * 1024 + 1)).status).toBe(413);
		expect(calls).toBe(before);
		expect((await postChunked(server.port, 70 * 1024, false)).status).toBe(413);
		expect(calls).toBe(before + 1);
	});

	it('refuses an ignored HTTP/2 body as it crosses 64 KiB', async () => {
		release();
		const before = calls;
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest'
		}, undefined, 'x'.repeat(4 * 1024 * 1024));
		expect(res.status).toBe(413);
		expect(res.body).toBe('Content Too Large');
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls).toBe(before + 1);
	});
});

describe('the dev auth body\'s held answer', () => {
	const runtimeUrl = new URL('../../src/runtime/runtime.js', import.meta.url).href;

	/** A request that delivers what a case emits on it. */
	const fakeRequest = () => Object.assign(new EventEmitter(), {
		aborted: false,
		readableEnded: false,
		pause() {},
		resume() {}
	});

	// The endpoint's 64 KiB cap is under one period's 160 KiB, so the restart
	// is driven on the reader itself with a larger budget. One period is 10 s
	// at 16 KiB/s.
	it('starts a new period once 160 KiB of the rest has come, and drops an answer that cannot close when one falls short', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
			const req = fakeRequest();
			let closed = 0;
			const input = authRequestBody(/** @type {any} */ (req), 1024 * 1024, { declared: false, refuse: () => {}, close: () => { closed++; } });
			const answer = /** @type {Promise<boolean | null>} */ (input.answer(false));
			expect(waits.size).toBe(1);
			const first = [...waits][0];
			req.emit('data', Buffer.alloc(100 * 1024));
			req.emit('data', Buffer.alloc(60 * 1024 - 1));
			expect(waits.has(first)).toBe(true);
			req.emit('data', Buffer.alloc(1));
			expect(waits.has(first)).toBe(false);
			expect(waits.size).toBe(1);
			const second = [...waits][0];
			req.emit('data', Buffer.alloc(160 * 1024 - 1));
			expect(waits.has(second)).toBe(true);
			second.fire();
			expect(await answer).toBe(null);
			expect(closed).toBe(1);
		});
	});

	it('fails the body for a reader that stops taking chunks, and waits for the rest instead', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async () => {
			const req = fakeRequest();
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: true, refuse: () => {}, close: () => {} });
			const reader = input.body.getReader();
			/** @type {boolean | null | undefined} */
			let decided;
			const answer = /** @type {Promise<boolean | null>} */ (input.answer(true)).then((close) => (decided = close));
			req.emit('data', Buffer.alloc(10));
			await settleTurn();
			await expect(reader.read()).rejects.toThrow('Request body not read');
			expect(decided).toBeUndefined();
			req.emit('end');
			expect(await answer).toBe(false);
		});
	});

	it('hands every chunk to a reader that keeps up while the answer waits', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async () => {
			const req = fakeRequest();
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: true, refuse: () => {}, close: () => {} });
			const reader = input.body.getReader();
			/** @type {number[]} */
			const got = [];
			const reading = (async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					got.push(value.byteLength);
				}
			})();
			const answer = input.answer(true);
			req.emit('data', Buffer.alloc(10));
			await settleTurn();
			req.emit('data', Buffer.alloc(20));
			await settleTurn();
			req.emit('end');
			expect(await answer).toBe(false);
			await reading;
			expect(got).toEqual([10, 20]);
		});
	});

	it('closes behind an answer that can carry it once the read in progress is over, for a body of undeclared length', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
			const req = fakeRequest();
			let closed = 0;
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: false, refuse: () => {}, close: () => { closed++; } });
			req.emit('data', Buffer.alloc(10));
			expect(await input.answer(true)).toBe(true);
			// The wait was cleared, never fired.
			expect(waits.size).toBe(0);
			expect(closed).toBe(0);
		});
	});

	it('waits for the rest of a declared body behind an answer that can carry the close', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async () => {
			const req = fakeRequest();
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: true, refuse: () => {}, close: () => {} });
			/** @type {boolean | null | undefined} */
			let decided;
			const answer = /** @type {Promise<boolean | null>} */ (input.answer(true)).then((close) => (decided = close));
			await settleTurn();
			expect(decided).toBeUndefined();
			req.emit('end');
			expect(await answer).toBe(false);
		});
	});

	it('closes behind the answer once a reader holding an undeclared body cancels it', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
			const req = fakeRequest();
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: false, refuse: () => {}, close: () => {} });
			const reader = input.body.getReader();
			/** @type {boolean | null | undefined} */
			let decided;
			const answer = /** @type {Promise<boolean | null>} */ (input.answer(true)).then((close) => (decided = close));
			await settleTurn();
			expect(decided).toBeUndefined();
			await reader.cancel();
			expect(await answer).toBe(true);
			expect(waits.size).toBe(0);
		});
	});

	it('gives the same decision when asked again, and none for a second answer behind a held one', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async () => {
			const complete = fakeRequest();
			const done = authRequestBody(/** @type {any} */ (complete), 64 * 1024, { declared: true, refuse: () => {}, close: () => {} });
			complete.emit('end');
			expect(done.answer(true)).toBe(false);
			expect(done.answer(true)).toBe(false);

			const req = fakeRequest();
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: true, refuse: () => {}, close: () => {} });
			const held = input.answer(false);
			expect(await input.answer(true)).toBe(null);
			req.emit('end');
			expect(await held).toBe(false);
			expect(input.answer(true)).toBe(false);
		});
	});

	it('answers with the close once the rest falls short, when the answer can carry it', async () => {
		await withHeldTimers(runtimeUrl, WAIT_LIMIT_MS, async (waits) => {
			const req = fakeRequest();
			let closed = 0;
			const input = authRequestBody(/** @type {any} */ (req), 64 * 1024, { declared: true, refuse: () => {}, close: () => { closed++; } });
			const answer = /** @type {Promise<boolean | null>} */ (input.answer(true));
			req.emit('data', Buffer.alloc(10));
			expect(waits.size).toBe(1);
			[...waits][0].fire();
			expect(await answer).toBe(true);
			expect(closed).toBe(0);
		});
	});
});

describe('the dev auth request stream', () => {
	/** @type {Awaited<ReturnType<typeof bootViteDev>>} */
	let server;
	/** @type {() => void} */
	let entered;
	beforeAll(async () => {
		server = await bootWithoutOrigin({
			h2: true,
			handler: {
				async authenticate({ request, headers }) {
					if (headers['x-auth-read-body'] !== '1') return undefined;
					entered?.();
					const bytes = await request.arrayBuffer();
					return new Response(null, { status: 204, headers: { 'x-body-length': String(bytes.byteLength) } });
				}
			}
		});
	});
	afterAll(async () => { await server?.close(); });

	it.each(['proxy', 'native error'])('contains a %s rejection whose prototype cannot be inspected', async (kind) => {
		let fail = true;
		const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('prototype unavailable'); } });
		const rejection = kind === 'native error' ? Object.setPrototypeOf(new Error('hook failed'), hostile) : hostile;
		const isolated = await bootWithoutOrigin({ handler: {
			authenticate() { if (fail) throw rejection; return undefined; }
		} });
		try {
			expect((await postChunked(isolated.port, 0, false)).status).toBe(500);
			fail = false;
			expect((await postChunked(isolated.port, 0, false)).status).toBe(204);
		} finally { await isolated.close(); }
	});

	it('contains a disconnect during an HTTP/1.1 body read and keeps serving', async () => {
		const reading = new Promise((resolve) => { entered = () => resolve(undefined); });
		const req = httpRequest({
			host: '127.0.0.1', port: server.port, path: '/__ws/auth', method: 'POST',
			headers: { 'content-length': '1024', 'x-requested-with': 'XMLHttpRequest', 'x-auth-read-body': '1' }
		});
		req.on('error', () => {});
		req.write('partial');
		await reading;
		req.destroy();
		const next = await postChunked(server.port, 1024);
		expect(next.status).toBe(204);
		expect(next.headers['x-body-length']).toBe('1024');
	});

	it('contains an HTTP/2 reset during a body read and keeps serving', async () => {
		const reading = new Promise((resolve) => { entered = () => resolve(undefined); });
		const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
		session.on('error', () => {});
		const stream = session.request({
			':method': 'POST', ':path': '/__ws/auth',
			'x-requested-with': 'XMLHttpRequest', 'x-auth-read-body': '1'
		});
		stream.on('error', () => {});
		try {
			stream.write('partial');
			await reading;
			const closed = new Promise((resolve) => stream.once('close', resolve));
			stream.close(http2Constants.NGHTTP2_CANCEL);
			await closed;
		} finally { session.destroy(); }
		const next = await h2Exchange(server.h2Port, {
			':method': 'POST', ':path': '/__ws/auth',
			'x-requested-with': 'XMLHttpRequest', 'x-auth-read-body': '1'
		}, undefined, 'next-body');
		expect(next.status).toBe(204);
		expect(next.headers['x-body-length']).toBe('9');
	});

	it('holds the answer to an ignored HTTP/2 body until its declared length has arrived', async () => {
		// The seam goes in before the request, whose wait it has to hold.
		await withHeldTimers(new URL('../../src/runtime/runtime.js', import.meta.url).href, WAIT_LIMIT_MS, async (waits) => {
			const before = new Set(waits);
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.on('error', () => {});
			const stream = session.request({
				':method': 'POST', ':path': '/__ws/auth',
				'x-requested-with': 'XMLHttpRequest', 'content-length': String(64 * 1024)
			});
			stream.on('error', () => {});
			try {
				let answered = false;
				const response = new Promise((resolve) => stream.once('response', (headers) => { answered = true; resolve(headers); }));
				stream.write('partial');
				await until(() => [...waits].some((t) => !before.has(t)));
				await settleTurn();
				expect(answered).toBe(false);
				stream.end('x'.repeat(64 * 1024 - 'partial'.length));
				expect((await response)[':status']).toBe(204);
			} finally { session.destroy(); }
		});
	});
});

const openssl = findOpenssl();

/**
 * The auth POST over HTTP/1.1 on TLS.
 *
 * @param {number} port
 * @param {Record<string, string>} headers
 * @param {string} ca
 */
function sendTls(port, headers, ca) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest({
			host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			ca,
			headers: { ...headers, 'content-length': '0' }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.once('error', reject);
		req.end();
	});
}

// Vite's own listener under `server.https`: `http2.createSecureServer` with
// HTTP/1.1 allowed, which a browser reaches over HTTP/2 for requests and over
// HTTP/1.1 for the WebSocket. Vite terminates TLS here, so a same-origin
// Origin is the `https://` one, as under production's SSL_CERT. These are the
// only cases that give the origin checks a TLS listener, so on CI a missing
// openssl fails them rather than skipping them.
(openssl === null && process.env.CI !== 'true' ? describe.skip : describe)('the dev plugin under server.https', () => {
	/** @type {{ port: number, close: () => Promise<void> }} */
	let server;
	/** @type {string} */
	let ca;
	/** @type {string | undefined} */
	let dir;
	beforeAll(async () => {
		if (openssl === null) throw new Error('the server.https cases need openssl, which CI must provide');
		dir = mkdtempSync(join(tmpdir(), 'uws-vite-tls-'));
		const tls = loopbackCertificate(openssl, dir);
		ca = tls.cert;
		server = await bootWithoutOrigin({ handler: withOwnLanes, tls });
	}, 120_000);
	afterAll(async () => {
		await server?.close();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it('holds the auth POST to an https same-origin Origin, over HTTP/2 and HTTP/1.1', async () => {
		const authority = `127.0.0.1:${server.port}`;
		/** @param {string} origin */
		const post = (origin) => h2Exchange(server.port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': authority,
			origin,
			'x-auth-echo': '1'
		}, ca);
		const accepted = await post(`https://${authority}`);
		expect(accepted.status).toBe(200);
		expect(JSON.parse(accepted.body).requestUrl).toBe(`https://${authority}/__ws/auth`);
		// The same host on the other scheme is another origin.
		expect((await post(`http://${authority}`)).status).toBe(403);

		const overHttp1 = await sendTls(server.port, { origin: `https://${authority}`, 'x-auth-echo': '1' }, ca);
		expect(overHttp1.status).toBe(200);
		expect(JSON.parse(overHttp1.body).requestUrl).toBe(`https://${authority}/__ws/auth`);
		expect((await sendTls(server.port, { origin: `http://${authority}`, 'x-auth-echo': '1' }, ca)).status).toBe(403);
	});

	it('strips a hook Response\'s connection headers over HTTP/1.1 on TLS', async () => {
		const res = await sendTls(server.port, { 'x-requested-with': 'XMLHttpRequest', 'x-connection-headers': '1' }, ca);
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		expect(res.headers.connection).not.toBe(CONNECTION_HEADERS.connection);
		expect(res.headers['keep-alive']).not.toBe(CONNECTION_HEADERS['keep-alive']);
		for (const name of NONFRAMING_CONNECTION_HEADERS) {
			expect(res.headers[name], name).toBeUndefined();
		}
	});

	it('writes a hook Response without the headers HTTP/2 does not carry, over HTTP/2 on TLS', async () => {
		const res = await h2Exchange(server.port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-connection-headers': '1'
		}, ca);
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		for (const name of Object.keys(CONNECTION_HEADERS)) {
			expect(res.headers[name], name).toBeUndefined();
		}
	});

	it('opens a WebSocket for an https same-origin Origin and refuses the http one', async () => {
		const authority = `127.0.0.1:${server.port}`;
		expect(await openWebSocket(`wss://${authority}/ws`, `https://${authority}`, ca)).toBe(101);
		expect(await openWebSocket(`wss://${authority}/ws`, `http://${authority}`, ca)).toBe(403);
	});
});

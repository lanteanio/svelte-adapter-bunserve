// The request target, against a real server over raw sockets, since every
// HTTP client drops a fragment and encodes the bytes under test.
//
// A fragment is refused 400 on every lane, as svelte-adapter-uws refuses it,
// and counted as a malformed handshake where that adapter counts one. The rest
// of what that adapter refuses here never reaches this one as sent: Bun hands a
// raw byte on percent-encoded and answers a control byte with its own 505.
// Those answers are pinned too, so a Bun that starts handing the bytes on is
// noticed.
//
// Runs against the fixture's MAIN build.

import { connect } from 'node:net';

import { HANDSHAKE } from '../helpers/handshake.mjs';
import { assertPortFree, buildPath, rawExchange, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8826;
const BUILD = buildPath('build');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/**
 * One request with these exact bytes, answered in full: read to its
 * Content-Length, or to the socket's end where it has none. Not to the end
 * alone, though the request asks to close: Bun holds the connection open past
 * an answer its handler awaited a macrotask for, as a route's first load does
 * (probe/bun-api-facts.report.md, connection-close).
 *
 * @param {string} method
 * @param {Buffer | string} target
 * @param {Record<string, string>} [headers]
 * @param {string} [host] the Host value, this server's own by default
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
function answerOf(method, target, headers = {}, host = `127.0.0.1:${PORT}`) {
	return new Promise((resolve, reject) => {
		const socket = connect(PORT, '127.0.0.1');
		const chunks = [];
		const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer to ${method} ${target}`)); }, 3000);
		let done = false;
		/** @param {boolean} closed */
		const settle = (closed) => {
			if (done) return;
			const text = Buffer.concat(chunks).toString('latin1');
			const end = text.indexOf('\r\n\r\n');
			if (end < 0) {
				if (closed) { done = true; clearTimeout(timer); reject(new Error(`no header block for ${method} ${target}`)); }
				return;
			}
			const [statusLine, ...lines] = text.slice(0, end).split('\r\n');
			/** @type {Record<string, string>} */
			const parsed = {};
			for (const line of lines) {
				const at = line.indexOf(':');
				parsed[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
			}
			const body = text.slice(end + 4);
			const length = parsed['content-length'];
			// A HEAD is read to the socket's end, so a body sent where none may
			// be is seen: every HEAD here is answered synchronously - refused,
			// or served from the static index - which Bun closes on at once.
			const complete = closed || (method !== 'HEAD' && length !== undefined && body.length >= Number(length));
			if (!complete) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve({ status: Number(statusLine.split(' ')[1]), headers: parsed, body });
		};
		socket.on('data', (c) => { chunks.push(c); settle(false); });
		socket.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
		socket.on('close', () => settle(true));
		socket.on('connect', () => {
			socket.write(Buffer.concat([
				Buffer.from(`${method} `, 'latin1'),
				Buffer.isBuffer(target) ? target : Buffer.from(target, 'latin1'),
				Buffer.from(
					` HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n` +
					Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
					(method === 'POST' ? 'Content-Length: 0\r\n' : '') +
					'\r\n',
					'latin1'
				)
			]));
		});
	});
}

/** The value of one rendered series, as a number. */
function series(text, prefix) {
	const line = text.split('\n').find((l) => l.startsWith(prefix + ' ') || l.startsWith(prefix + '{'));
	return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}
const malformed = async () =>
	series(await (await fetch(`${BASE}/metrics`)).text(), 'upgrade_rejected_total{reason="malformed_handshake"}');

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);

	// A fragment, on each lane: the probe, the built asset, the prerendered
	// page, the SSR catch-all and a POST endpoint.
	for (const [method, target] of [
		['GET', '/healthz#frag'],
		['GET', '/healthz?x=1#y'],
		['GET', '/healthz#'],
		['GET', '/readyz#x'],
		['POST', '/__ws/auth#x'],
		['GET', '/test.txt#part'],
		['GET', '/about#x'],
		['GET', '/client-address#x'],
		['POST', '/echo#x']
	]) {
		const answer = await answerOf(method, target);
		check(`${method} ${target} is refused 400`, answer.status === 400 && answer.body === 'Bad Request',
			`got ${answer.status} ${JSON.stringify(answer.body.slice(0, 60))}`);
	}
	// Validate Host before dispatch, including routes that do not build an app URL.
	const validProbe = await answerOf('GET', '/healthz');
	check('a probe with a valid Host responds normally', validProbe.status === 200 && validProbe.body === 'OK');
	for (const host of ['a#b', 'a/healthz?', 'a/../healthz?', 'a/?x#frag', 'a\\b', 'a b', 'a:80:80', '']) {
		const probe = await answerOf('GET', '/healthz', {}, host);
		check(`probe refuses invalid Host ${JSON.stringify(host)}`, probe.status === 400, `got ${probe.status}`);
		const app = await answerOf('GET', '/target', {}, host);
		check(`app refuses invalid Host ${JSON.stringify(host)}`, app.status === 400, `got ${app.status}`);
		const auth = await answerOf('POST', '/__ws/auth', { 'x-requested-with': 'XMLHttpRequest' }, host);
		check(`auth refuses invalid Host ${JSON.stringify(host)}`, auth.status === 400, `got ${auth.status}`);
	}
	const plain = await answerOf('GET', '/test.txt');
	check('and the same asset without one is served', plain.status === 200, `got ${plain.status}`);

	const head = await answerOf('HEAD', '/test.txt#part');
	check('a HEAD with a fragment is refused 400 with no body',
		head.status === 400 && head.body === '' && head.headers['content-length'] === '11',
		`got ${head.status}, content-length ${head.headers['content-length']}, body ${JSON.stringify(head.body)}`);

	// The handshake: counted where uws's WebSocket route would have taken it.
	const before = await malformed();
	const inQuery = await answerOf('GET', '/ws?x=1#y', HANDSHAKE);
	check('a handshake with a fragment in its query is refused 400', inQuery.status === 400, `got ${inQuery.status}`);
	const afterQuery = await malformed();
	check('and counted as a malformed handshake', afterQuery - before === 1, `${before} -> ${afterQuery}`);
	const inPath = await answerOf('GET', '/ws#x', HANDSHAKE);
	check('a handshake with a fragment in its path is refused 400', inPath.status === 400, `got ${inPath.status}`);
	check('and not counted, as that path misses the WebSocket route', (await malformed()) === afterQuery,
		String(await malformed()));

	// A spelling SvelteKit would route onto one of the adapter's own paths: its
	// data or route-resolution request, or an escape of its letters. Refused
	// whatever the method. The main build mounts the probes and the auth path;
	// with no admission limit the WebSocket path's pages are the app's.
	for (const [method, target] of [
		['GET', '/healthz/__data.json'],
		['GET', '/healthz/__data.json?x-sveltekit-invalidated=01'],
		['GET', '/healthz/__data.json??x-sveltekit-trailing-slash=1'],
		['GET', '/readyz/__route.js'],
		['GET', '/%68ealthz'],
		['GET', '/%68ealthz/__data.json'],
		['GET', '/__ws/auth/__data.json'],
		['POST', '/healthz/__data.json']
	]) {
		const answer = await answerOf(method, target);
		check(`${method} ${target} is refused 400`, answer.status === 400 && answer.body === 'Bad Request',
			`got ${answer.status} ${JSON.stringify(answer.body.slice(0, 60))}`);
	}
	// The app's own answers: the fixture's root page has data, and it routes
	// nothing at /healthz/ or as a page at /ws, so SvelteKit answers 404 there.
	for (const [target, status] of [
		['/__data.json', 200],
		['/healthz/', 404],
		['/healthz/__data.json?x-sveltekit-trailing-slash=1', 404],
		['/ws/__data.json', 404]
	]) {
		const answer = await answerOf('GET', target);
		check(`GET ${target} is left to the app (${status})`, answer.status === status, `got ${answer.status}`);
	}
	// Bun resolves dot segments before the adapter sees the target, so a
	// spelling through them is the path itself on every lane here, where uws
	// refuses it: the probe answers it, and a handshake on it opens a socket.
	const resolved = await answerOf('GET', '/x/../healthz');
	check('/x/../healthz arrives as the probe and is answered by it', resolved.status === 200 && resolved.body === 'OK',
		`got ${resolved.status} ${JSON.stringify(resolved.body)}`);
	const resolvedWs = await rawExchange(PORT, Object.entries(HANDSHAKE), { path: '/x/../ws' });
	check('and a handshake on /x/../ws is a handshake on the WebSocket path', resolvedWs.status === 101,
		`got ${resolvedWs.status}`);

	// A static file whose name a browser encodes, `static/maß.txt`, served for
	// that spelling in either letter case. Its raw bytes reach the handler
	// encoded on Bun, so they are served too, where uws refuses them.
	for (const [label, target] of [
		['its encoded spelling', '/ma%C3%9F.txt'],
		['lowercase escapes', '/ma%c3%9f.txt'],
		['the raw bytes, which Bun encodes', Buffer.concat([Buffer.from('/ma'), Buffer.from([0xc3, 0x9f]), Buffer.from('.txt')])]
	]) {
		const answer = await answerOf('GET', target);
		// By content rather than to the byte: a checkout may give the fixture
		// CRLF line endings.
		check(`a static file with a non-ASCII name is served for ${label}`,
			answer.status === 200 && answer.body.includes('static-non-ascii-name'), `got ${answer.status} ${JSON.stringify(answer.body)}`);
	}
	const encodedGet = await answerOf('GET', '/ma%C3%9F.txt');
	const encodedHead = await answerOf('HEAD', '/ma%C3%9F.txt');
	check('and HEAD answers it with no body and the GET\'s length', encodedHead.status === 200 && encodedHead.body === '' &&
		encodedHead.headers['content-length'] === encodedGet.headers['content-length'],
		`got ${encodedHead.status} ${encodedHead.headers['content-length']} vs ${encodedGet.headers['content-length']}`);
	const postEncoded = await answerOf('POST', '/ma%C3%9F.txt');
	check('a POST to that spelling is not served the file', !postEncoded.body.includes('static-non-ascii-name'),
		`got ${postEncoded.status}`);
	// Decoded as SvelteKit's Node adapter decodes, which leaves `%2F` encoded:
	// an escaped separator does not reach into a directory.
	const wellKnown = await answerOf('GET', '/.well-known/probe.txt');
	const separator = await answerOf('GET', '/.well-known%2Fprobe.txt');
	check('/.well-known/probe.txt is served on its own spelling', wellKnown.status === 200, `got ${wellKnown.status}`);
	check('and not through an escaped separator', separator.status !== 200 && separator.body !== wellKnown.body,
		`got ${separator.status}`);
	// A download whose name is outside Latin-1: its Content-Disposition goes out
	// as the name's UTF-8 bytes, as svelte-adapter-uws writes it.
	const zipName = String.fromCharCode(0x141, 0xf3) + 'd' + String.fromCharCode(0x17a) + '.zip';
	const zip = await answerOf('GET', '/' + encodeURIComponent(zipName));
	check('a download named outside Latin-1 is served for its encoded spelling', zip.status === 200 && zip.body === 'zip-non-latin1',
		`got ${zip.status} ${JSON.stringify(zip.body.slice(0, 60))}`);
	const disposition = zip.headers['content-disposition'] ?? '';
	check('with its name in Content-Disposition as UTF-8 bytes',
		Buffer.from(disposition, 'latin1').toString('utf8') === `attachment; filename="${zipName}"`, JSON.stringify(disposition));

	// What Bun does with the bytes it does not hand on as sent: the fixture's
	// /target route answers with the query the app received.
	for (const [label, bytes, escaped] of [
		['raw UTF-8 e-acute', [0xc3, 0xa9], '?x=%C3%A9'],
		['a lone 0xe9 (not UTF-8)', [0xe9], '?x=%EF%BF%BD'],
		['DEL', [0x7f], '?x=%7F']
	]) {
		const answer = await answerOf('GET', Buffer.concat([Buffer.from('/target?x='), Buffer.from(bytes)]));
		check(`${label} in the query reaches the app as ${escaped}`, answer.status === 200 && answer.body === escaped,
			`got ${answer.status} ${JSON.stringify(answer.body)}`);
	}
	for (const [label, target] of [['a tab', '/target\tx'], ['a NUL', '/target\x00x'], ['a 0x1f', '/target\x1fx']]) {
		const answer = await answerOf('GET', target);
		check(`${label} in the target is Bun's own 505`, answer.status === 505, `got ${answer.status}`);
	}
} finally {
	proc.kill();
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}

// Duplicate forwarded headers, on the wire. fetch() and new Request() cannot
// send them - every Headers implementation joins duplicates at construction,
// so a check built on either only ever exercises the one pre-joined value the
// adapter would have seen anyway. These requests are written as raw bytes so
// the server parses two literal X-Forwarded-For lines, which is the one place
// the generations differ: 1.3 surfaces only the LAST line, 1.4 joins them per
// the Fetch spec (recorded in probe/bun-api-facts.report.md and pinned per
// generation below).
//
// What must NOT differ is the selected client identity at the default depth.
// XFF_DEPTH counts hops from the END of the chain, and the end of the joined
// chain is the end of the last line - the only part a client cannot write, on
// either generation. That invariant is what makes the rate-limit keying safe
// across the floor and the 1.4 lane at once, and it is the property this
// check exists to hold.

import { connect } from 'node:net';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8815;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

// 1.4.0 is the first generation that joins duplicate header lines.
const [major, minor] = Bun.version.split('.').map(Number);
const JOINS_DUPLICATES = major > 1 || (major === 1 && minor >= 4);

// How long one request may take to produce a complete response before this
// gives up. The requests here are answered in single-digit milliseconds, so
// this only ever fires on a wedge - and it has to fire HERE, because the lane's
// own step timeout is minutes away and reports nothing about which request hung.
const RESPONSE_TIMEOUT_MS = 10_000;

/**
 * Decode a chunked body, or null while it is still incomplete.
 *
 * @param {Buffer} buf - everything after the response head
 * @returns {string | null}
 */
function decodeChunked(buf) {
	/** @type {Buffer[]} */
	const out = [];
	let at = 0;
	for (;;) {
		const nl = buf.indexOf('\r\n', at);
		if (nl === -1) return null;
		const size = parseInt(buf.toString('latin1', at, nl), 16);
		if (Number.isNaN(size)) return null;
		if (size === 0) return Buffer.concat(out).toString('utf8');
		const start = nl + 2;
		const end = start + size;
		// The chunk plus its trailing CRLF.
		if (buf.length < end + 2) return null;
		out.push(buf.subarray(start, end));
		at = end + 2;
	}
}

/**
 * The complete body of the response in `buf`, or null while it is still
 * arriving. `closed` reports whether the peer has hung up, which is what
 * delimits a body that declares neither a length nor chunked framing.
 *
 * @param {Buffer} buf
 * @param {boolean} closed
 * @returns {string | null}
 */
function completeBody(buf, closed) {
	const split = buf.indexOf('\r\n\r\n');
	if (split === -1) return null;
	const head = buf.toString('latin1', 0, split);
	const body = buf.subarray(split + 4);
	if (/transfer-encoding:\s*chunked/i.test(head)) return decodeChunked(body);
	const length = /content-length:\s*(\d+)/i.exec(head);
	if (length) {
		const want = Number(length[1]);
		return body.length >= want ? body.toString('utf8', 0, want) : null;
	}
	return closed ? body.toString('utf8') : null;
}

/**
 * One raw HTTP/1.1 request with full control over the header lines, including
 * repeats. Returns the parsed JSON body of the response.
 *
 * The socket is dropped as soon as the response is complete rather than waited
 * on. Bun leaves a connection open past the request's `Connection: close`
 * whenever the handler yielded to the macrotask queue before returning
 * (probe/bun-api-facts.report.md, connection-close), and every SSR response
 * does - so the close arrives when the server's 120s idle timeout fires, not
 * when the response ends. Reading until hangup costs two minutes a request,
 * which puts the four here well past the lane's step timeout.
 *
 * @param {string[]} headerLines
 * @returns {Promise<{ address: string | null, error: string | null }>}
 */
function rawRequest(headerLines) {
	return new Promise((resolve, reject) => {
		const socket = connect(PORT, '127.0.0.1');
		/** @type {Buffer[]} */
		const chunks = [];
		let settled = false;
		/** @type {ReturnType<typeof setTimeout>} */
		let timer;

		/** @param {(value: any) => void} settle @param {any} value */
		const finish = (settle, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			settle(value);
		};

		/** @param {boolean} closed */
		const tryComplete = (closed) => {
			const buf = Buffer.concat(chunks);
			const body = completeBody(buf, closed);
			if (body === null) {
				if (closed) {
					finish(reject, new Error('no complete response before the peer hung up: ' +
						buf.toString('utf8').slice(0, 200)));
				}
				return;
			}
			try { finish(resolve, JSON.parse(body)); }
			catch { finish(reject, new Error('unparseable body: ' + body.slice(0, 200))); }
		};

		timer = setTimeout(() => {
			finish(reject, new Error(`no complete response within ${RESPONSE_TIMEOUT_MS}ms; got ` +
				JSON.stringify(Buffer.concat(chunks).toString('utf8').slice(0, 200))));
		}, RESPONSE_TIMEOUT_MS);

		socket.on('data', (chunk) => { chunks.push(chunk); tryComplete(false); });
		socket.on('error', (err) => finish(reject, err));
		socket.on('close', () => tryComplete(true));
		socket.on('connect', () => {
			socket.write(
				'GET /client-address HTTP/1.1\r\n' +
				`Host: 127.0.0.1:${PORT}\r\n` +
				headerLines.map((l) => l + '\r\n').join('') +
				'Connection: close\r\n' +
				'\r\n'
			);
		});
	});
}

/** @param {Record<string, string>} env @param {(name: string) => Promise<void>} body */
async function withServer(env, body) {
	await assertPortFree(PORT);
	const proc = Bun.spawn([process.execPath, BUILD], {
		env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ...env }),
		stdout: 'pipe',
		stderr: 'pipe'
	});
	// A THROW out of the body increments `failed` in the outer catch, which runs
	// AFTER this finally - so the flag has to be raised here, or the one failure
	// mode that most needs the server's own words prints none of them.
	let threw = false;
	try {
		await waitForServer(proc, PORT);
		await body();
	} catch (err) {
		threw = true;
		throw err;
	} finally {
		proc.kill();
		if (failed > 0 || threw) {
			console.log('\n--- stderr ---\n' + (await new Response(proc.stderr).text()).slice(-1500));
		}
		await proc.exited;
	}
}

const DUPLICATES = [
	'X-Forwarded-For: 203.0.113.1, 203.0.113.2',
	'X-Forwarded-For: 198.51.100.7, 198.51.100.8'
];

try {
	await withServer({ ADDRESS_HEADER: 'x-forwarded-for', XFF_DEPTH: '1' }, async () => {
		const control = await rawRequest(['X-Forwarded-For: 203.0.113.1, 203.0.113.2']);
		check('one header line selects its last hop at depth 1',
			control.address === '203.0.113.2', JSON.stringify(control));

		const dup = await rawRequest(DUPLICATES);
		check('two header lines select the last hop of the LAST line at depth 1',
			dup.address === '198.51.100.8', JSON.stringify(dup));
		check('which is the same hop the joined chain means - the invariant across generations',
			dup.address === '198.51.100.8' && dup.error === null, JSON.stringify(dup));
	});

	await withServer({ ADDRESS_HEADER: 'x-forwarded-for', XFF_DEPTH: '3' }, async () => {
		// Depth 3 is where the generations tell each other apart: the joined
		// chain carries four hops and answers, the last-line-only view carries
		// two and refuses. Both outcomes are pinned as the recorded facts they
		// are - a generation answering the OTHER one's outcome means the header
		// surfacing changed under us and the identity keying needs re-review.
		const deep = await rawRequest(DUPLICATES);
		if (JOINS_DUPLICATES) {
			check('depth 3 selects across the join on a generation that joins',
				deep.address === '203.0.113.2', JSON.stringify(deep));
		} else {
			check('depth 3 overruns a last-line-only view and refuses rather than guessing',
				deep.address === null && /only found 2/.test(deep.error ?? ''), JSON.stringify(deep));
		}
	});
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log('failures:\n  - ' + failures.join('\n  - '));
	process.exit(1);
}

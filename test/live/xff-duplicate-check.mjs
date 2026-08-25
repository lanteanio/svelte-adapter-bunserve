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

const PORT = 8812;
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

/**
 * One raw HTTP/1.1 request with full control over the header lines, including
 * repeats. Returns the parsed JSON body of the response.
 *
 * @param {string[]} headerLines
 * @returns {Promise<{ address: string | null, error: string | null }>}
 */
function rawRequest(headerLines) {
	return new Promise((resolve, reject) => {
		const socket = connect(PORT, '127.0.0.1');
		let data = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => { data += chunk; });
		socket.on('error', reject);
		socket.on('close', () => {
			const split = data.indexOf('\r\n\r\n');
			if (split === -1) return reject(new Error('no response head in: ' + data.slice(0, 200)));
			let body = data.slice(split + 4);
			// Connection: close still allows chunked framing; strip it if present.
			if (/transfer-encoding:\s*chunked/i.test(data.slice(0, split))) {
				body = body.split('\r\n').filter((line) => !/^[0-9a-f]*$/i.test(line.trim())).join('');
			}
			try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('unparseable body: ' + body.slice(0, 200))); }
		});
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
	try {
		await waitForServer(proc, PORT);
		await body();
	} finally {
		proc.kill();
		if (failed > 0) {
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

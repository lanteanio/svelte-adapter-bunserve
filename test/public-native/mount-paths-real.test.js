// The mount spelling rule against real clients and a real Bun server. The
// adapter compares a mount with the request target as Bun hands it on, so a
// spelling is admissible exactly when fetch and node:http, each handed the
// path a person would write, reach it as written. createTestServer applies
// the rule to its own path options, as the adapter build does.

import { describe, test, expect } from 'bun:test';
import http from 'node:http';
import { connect } from 'node:net';
import { createTestServer } from '../../src/testing.js';
import { mountPathProblem } from '../../src/runtime/utils/mount-path.js';
import { requestTarget } from '../../src/runtime/utils/request-target.js';

/**
 * A Bun server answering each of `spellings` on the target compared exactly,
 * as the adapter compares its mounts, and `none` for anything else.
 * @param {string[]} spellings
 * @param {(port: number) => Promise<void>} drive
 */
async function withServer(spellings, drive) {
	const mounted = new Set(spellings);
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req) {
			const target = requestTarget(req);
			const query = target.indexOf('?');
			const pathname = query === -1 ? target : target.slice(0, query);
			return new Response(mounted.has(pathname) ? pathname : 'none');
		}
	});
	try {
		await drive(server.port);
	} finally {
		server.stop(true);
	}
}

/** What `fetch` reaches for `target`. */
async function reach(port, target) {
	return (await (await fetch(`http://127.0.0.1:${port}${target}`)).text());
}

/** What `node:http` reaches for `target`, as the URL parser hands it over. */
function reachHttp(port, target) {
	const { pathname } = new URL(`http://127.0.0.1:${port}${target}`);
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, (res) => {
			let body = '';
			res.setEncoding('latin1');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve(body));
		}).on('error', reject);
	});
}

/**
 * The body answered for one request line sent exactly as written.
 * @param {number} port
 * @param {string} target
 */
function rawReach(port, target) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.concat([
			Buffer.from('GET '), Buffer.from(target, 'utf8'), Buffer.from(' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
		])));
		socket.on('data', (c) => chunks.push(c));
		socket.on('error', reject);
		socket.on('close', () => {
			const text = Buffer.concat(chunks).toString('latin1');
			resolve(text.slice(text.indexOf('\r\n\r\n') + 4));
		});
	});
}

/**
 * The path a person writes into a URL for the decoded path `decoded`: as it
 * reads, except the three characters that are URL syntax, which no one can
 * write into a path unescaped.
 * @param {string} decoded
 */
function written(decoded) {
	return decoded.replace(/[%?#]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

describe('mount path spelling against real clients and a real Bun server', () => {
	// Every ASCII character and a few beyond it between two letters, raw and as
	// an uppercase and a lowercase escape. Router syntax at a segment's start
	// and dot segments have their own cases below; none arises here.
	test('admits exactly the spellings fetch and node:http reach for the written path', async () => {
		/** @type {Map<string, string>} */
		const decodedOf = new Map();
		const chars = [];
		for (let code = 0; code < 0x80; code++) chars.push(String.fromCharCode(code));
		chars.push('ü', '€', '😀');
		for (const ch of chars) {
			decodedOf.set('/a' + ch + 'b', '/a' + ch + 'b');
			const escape = [...new TextEncoder().encode(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
			decodedOf.set('/a' + escape + 'b', '/a' + ch + 'b');
			decodedOf.set('/a' + escape.toLowerCase() + 'b', '/a' + ch + 'b');
		}
		const disagreements = [];
		await withServer([...decodedOf.keys()], async (port) => {
			for (const [spelling, decoded] of decodedOf) {
				const target = written(decoded);
				const viaFetch = await reach(port, target);
				const viaHttp = await reachHttp(port, target);
				const reachable = viaFetch === spelling && viaHttp === spelling;
				const admitted = mountPathProblem(spelling) === null;
				if (admitted !== reachable) disagreements.push({ spelling, admitted, viaFetch, viaHttp });
			}
		});
		expect(disagreements).toEqual([]);
	}, 60000);

	test('answers admitted spellings with router syntax inside a segment for the path a client writes', async () => {
		const admitted = ['/status:live', '/ops*', '/v1/things:batchGet', '/gesundheit-pr%C3%BCfung', '/files/100%25', "/s!$&'()+,;=@~x"];
		for (const spelling of admitted) expect(mountPathProblem(spelling)).toBeNull();
		await withServer(admitted, async (port) => {
			expect(await reach(port, '/status:live')).toBe('/status:live');
			expect(await reach(port, '/ops*')).toBe('/ops*');
			expect(await reach(port, '/v1/things:batchGet')).toBe('/v1/things:batchGet');
			expect(await reach(port, '/gesundheit-prüfung')).toBe('/gesundheit-pr%C3%BCfung');
			expect(await reach(port, written('/files/100%'))).toBe('/files/100%25');
			expect(await reach(port, "/s!$&'()+,;=@~x")).toBe("/s!$&'()+,;=@~x");
			// Bun hands a raw UTF-8 target on with uppercase escapes, so even a
			// client that sends the character raw reaches the admitted spelling.
			expect(await rawReach(port, '/gesundheit-prüfung')).toBe('/gesundheit-pr%C3%BCfung');
		});
	});

	test('refuses dot segments, which clients resolve away, and router syntax at a segment\'s start', async () => {
		const unreachable = [['/a/../b', '/a/../b'], ['/a/./b', '/a/./b'], ['/a/%2E%2E/b', '/a/../b']];
		for (const [spelling] of unreachable) expect(mountPathProblem(spelling)).not.toBeNull();
		await withServer(unreachable.map(([spelling]) => spelling), async (port) => {
			for (const [spelling, target] of unreachable) expect(`${spelling}: ${await reach(port, target)}`).toBe(`${spelling}: none`);
			// Nor sent raw: Bun resolves the dot segment before the handler runs.
			expect(await rawReach(port, '/a/../b')).toBe('none');
		});
		// Bun's own routing here is an exact compare, but svelte-adapter-uws's
		// router reads these as a parameter and a wildcard, so a config carrying
		// one would not build there.
		for (const spelling of ['/:id', '/x/*']) expect(mountPathProblem(spelling)).not.toBeNull();
	});
});

describe('createTestServer options', () => {
	for (const [options, why] of [
		[{ healthCheckPath: '/gesundheit-prüfung' }, /healthCheckPath contains "ü"/],
		[{ readinessCheckPath: '/ready ' }, /readinessCheckPath contains U\+0020/],
		[{ wsPath: '/w#s' }, /wsPath contains "#"/],
		[{ adminPath: '/*ops' }, /adminPath has a segment starting with "\*"/],
		[{ upgradeAdmission: { maxConcurrent: 2, waitingRoom: { path: '/warte raum' } } }, /waitingRoom\.path contains U\+0020/],
		[{ upgradeAdmission: { maxConcurrent: 2, waitingRoom: { admitCheckPath: '/check/./now' } } }, /waitingRoom\.admitCheckPath contains a "\." segment/],
		[{ healthCheckPath: '/__realtime/health' }, /sits at or under the createTestServer option adminPath/],
		[{ readinessCheckPath: '/ws' }, /readinessCheckPath \("\/ws"\) must differ from the createTestServer option wsPath/]
	]) {
		test(`refuses ${JSON.stringify(options)}`, async () => {
			await expect(createTestServer(options)).rejects.toThrow(why);
		});
	}

	test('answers probes spelled with router syntax inside a segment and with escapes', async () => {
		const server = await createTestServer({ healthCheckPath: '/status:live', readinessCheckPath: '/bereit-pr%C3%BCfung' });
		try {
			const live = await fetch(server.url + '/status:live');
			expect(live.status).toBe(200);
			await live.arrayBuffer();
			const ready = await fetch(server.url + '/bereit-prüfung');
			expect(ready.status).toBe(200);
			await ready.arrayBuffer();
		} finally {
			await server.close();
		}
	});

	test('reads null and an empty healthCheckPath as no liveness route', async () => {
		for (const healthCheckPath of [null, '']) {
			const server = await createTestServer({ healthCheckPath });
			try {
				const response = await fetch(server.url + '/healthz');
				expect(response.status).toBe(404);
				await response.arrayBuffer();
			} finally {
				await server.close();
			}
		}
	});
});

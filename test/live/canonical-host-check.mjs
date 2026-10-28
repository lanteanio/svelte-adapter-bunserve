import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
const port = 8870;
await assertPortFree(port);
function raw(method, path, headers = {}, body = '') {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
			const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout'))); req.end(body);
	});
}
function wire(message) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port }, () => socket.write(message));
		let text = ''; socket.on('data', chunk => { text += chunk.toString(); }); socket.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d+)/.exec(text)?.[1])));
		socket.on('error', reject); socket.setTimeout(5000, () => socket.destroy(new Error('raw framing timeout')));
	});
}
let checks = 0;
for (const proxy of [false, true]) {
	const env = { HOST: '127.0.0.1', PORT: String(port), ORIGIN: 'https://canonical.example:443/', CANONICAL_HOST_ALIASES: 'old.example,old.example:80' };
	if (proxy) Object.assign(env, { HOST_HEADER: 'x-proxy-host', PORT_HEADER: 'x-proxy-port', PROTOCOL_HEADER: 'x-proxy-protocol', TRUSTED_PROXIES: '192.0.2.1' });
	const proc = Bun.spawn([process.execPath, buildPath()], { env: serverEnv(env), stdout: 'pipe', stderr: 'pipe' });
	try {
		await waitForServer(proc, port);
		const alias = proxy ? { host: 'internal.example', 'x-proxy-host': 'old.example', 'x-proxy-port': '80', 'x-proxy-protocol': 'http' } : { host: 'OLD.EXAMPLE' };
		if (proxy) {
			assert.equal(await wire('GET /head-contract HTTP/1.1\r\nHost: internal.example\r\nX-Proxy-Host: ignored.example\r\nX-Proxy-Host: old.example\r\nX-Proxy-Port: 81\r\nX-Proxy-Port: 80\r\nX-Proxy-Protocol: https\r\nX-Proxy-Protocol: http\r\nConnection: close\r\n\r\n'), 400); checks++;
			for (const [name, value] of [['x-proxy-host', 'evil.example, old.example'], ['x-proxy-port', '81, 80'], ['x-proxy-protocol', 'https, http']]) {
				assert.equal((await raw('GET', '/head-contract', { host: 'internal.example', 'x-proxy-host': 'old.example', 'x-proxy-port': '80', 'x-proxy-protocol': 'http', [name]: value })).status, 400); checks++;
			}
		}
		for (const method of ['GET', 'HEAD', 'POST']) {
			const result = await raw(method, '/head-contract?x=%2F%2b&empty=', alias, method === 'POST' ? 'payload' : '');
			assert.equal(result.status, 308); assert.equal(result.headers.location, 'https://canonical.example/head-contract?x=%2F%2b&empty='); assert.equal(result.body.length, 0); checks++;
		}
		for (const path of ['/test.txt', '/about']) {
			const result = await raw('GET', path, alias);
			assert.equal(result.status, 308); assert.equal(result.headers.location, 'https://canonical.example' + path); checks++;
		}
		const overlapping = await Promise.all(Array.from({ length: 12 }, (_, i) => raw('GET', '/head-contract', i % 2 ? alias : { host: 'canonical.example' })));
		assert.deepEqual(overlapping.map(result => result.status), Array.from({ length: 12 }, (_, i) => i % 2 ? 308 : 200)); checks++;
		for (const path of ['/healthz', '/readyz']) { assert.notEqual((await raw('GET', path, alias)).status, 308); checks++; }
		for (const host of ['canonical.example', '127.0.0.1', 'container.example']) { assert.equal((await raw('GET', '/head-contract', { host })).status, 200); checks++; }
		assert.equal(await wire('GET /head-contract#fragment HTTP/1.1\r\nHost: old.example\r\nConnection: close\r\n\r\n'), 400); checks++;
		for (const host of ['old.example:81', 'notold.example', 'old.example.evil']) { assert.equal((await raw('GET', '/head-contract', { host })).status, 200); checks++; }
		for (const host of ['old.example, evil.example', 'bad/path']) { assert.equal((await raw('GET', '/head-contract', { host })).status, 400); checks++; }
	} finally { proc.kill(); await proc.exited; }
}

for (const overrides of [
	{ CANONICAL_HOST_ALIASES: 'old.example' },
	{ ORIGIN: 'https://user:pass@canonical.example', CANONICAL_HOST_ALIASES: 'old.example' },
	{ ORIGIN: 'https://canonical.example/path', CANONICAL_HOST_ALIASES: 'old.example' },
	{ ORIGIN: 'https://canonical.example?x=1', CANONICAL_HOST_ALIASES: 'old.example' },
	{ ORIGIN: 'https://canonical.example#fragment', CANONICAL_HOST_ALIASES: 'old.example' },
	{ ORIGIN: 'https://canonical.example', CANONICAL_HOST_ALIASES: 'canonical.example:443' },
	{ ORIGIN: 'https://canonical.example', CANONICAL_HOST_ALIASES: 'old.example/path' },
	{ ORIGIN: 'https://canonical.example', CANONICAL_HOST_ALIASES: 'old.example,' }
]) {
	const proc = Bun.spawn([process.execPath, buildPath()], { env: serverEnv({ HOST: '127.0.0.1', PORT: String(port), ...overrides }), stdout: 'pipe', stderr: 'pipe' });
	const timer = setTimeout(() => proc.kill(), 5000);
	try {
		assert.notEqual(await proc.exited, 0);
		assert.match(await new Response(proc.stderr).text(), /ORIGIN|CANONICAL_HOST_ALIASES/, JSON.stringify(overrides)); checks++;
	} finally { clearTimeout(timer); proc.kill(); await proc.exited; }
}

const plain = Bun.spawn([process.execPath, buildPath()], { env: serverEnv({ HOST: '127.0.0.1', PORT: String(port), ORIGIN: 'https://canonical.example' }), stdout: 'pipe', stderr: 'pipe' });
try { await waitForServer(plain, port); assert.equal((await raw('GET', '/head-contract', { host: 'old.example' })).status, 200); checks++; }
finally { plain.kill(); await plain.exited; }

// Substitute only the two generated build-time probe options in a temporary
// sibling of the real runtime module, so all relative production imports stay intact.
const generatedServer = new URL('../fixture/build/server.js', import.meta.url);
const customModule = new URL(`../fixture/build/.canonical-probes-${process.pid}.mjs`, import.meta.url);
let serverCode = readFileSync(generatedServer, 'utf8');
for (const [from, to] of [['const healthPath = "/healthz";', 'const healthPath = "/private/health";'], ['const readinessPath = "/readyz";', 'const readinessPath = "/private/ready";']]) {
	assert.ok(serverCode.includes(from)); serverCode = serverCode.replace(from, to);
}
writeFileSync(customModule, serverCode);
const custom = Bun.spawn([process.execPath, '-e', `const { start } = await import(${JSON.stringify(customModule.href)}); start('127.0.0.1', ${port}); const { markReady } = await import(${JSON.stringify(new URL('../fixture/build/handler/lifecycle.js', import.meta.url).href)}); markReady();`], { env: serverEnv({ ORIGIN: 'https://canonical.example', CANONICAL_HOST_ALIASES: 'old.example' }), stdout: 'pipe', stderr: 'pipe' });
try {
	await waitForServer(custom, port, '/private/health');
	for (const path of ['/private/health', '/private/ready']) for (const method of ['GET', 'HEAD']) { assert.equal((await raw(method, path, { host: 'old.example' })).status, 200); checks++; }
	for (const path of ['/healthz', '/readyz']) { assert.equal((await raw('GET', path, { host: 'old.example' })).status, 308); checks++; }
	for (const headers of ['Host: old.example\r\nHost: other.example', 'Host: old.example\r\nContent-Length: 0\r\nTransfer-Encoding: chunked']) {
		const status = await wire('POST /head-contract HTTP/1.1\r\n' + headers + '\r\nConnection: close\r\n\r\n0\r\n\r\n');
		assert.equal(status, 400); checks++;
	}
} finally { custom.kill(); await custom.exited; unlinkSync(customModule); }
console.log(`${checks} canonical host native checks passed`);

import assert from 'node:assert/strict';
import { assertPortFree, buildPath, rawExchange, serverEnv, waitForServer } from './harness.mjs';

const port = 8896;
const origin = `http://127.0.0.1:${port}`;
const digest = 'Digest username="fixture", realm="room"';
const cases = [
	['authorization', digest, ['Digest username="fixture"', 'realm="room"']],
	['proxy-authorization', digest, ['Digest username="fixture"', 'realm="room"']],
	['content-type', 'text/plain; note="one, two"', ['text/plain; note="one', 'two"']],
	['origin', `${origin}, ${origin}`, [origin, origin]]
];
const routes = [
	{ name: 'HTTP', path: '/identity-headers', method: 'GET', accepted: 200 },
	{ name: 'authentication', path: '/__ws/auth?mode=identity-headers', method: 'POST', accepted: 200, originGate: true },
	{ name: 'admin', path: '/__realtime/headers?identityHeaders', method: 'GET', accepted: 200 },
	{ name: 'upgrade', path: '/ws?identityHeaders', method: 'GET', accepted: 101, originGate: true, upgrade: true }
];

function fields(route) {
	return [
		['origin', origin], ['authorization', 'Bearer admin'],
		...(route.method === 'POST' ? [['content-length', '0']] : []),
		...(route.upgrade ? [
			['connection', 'Upgrade'], ['upgrade', 'websocket'],
			['sec-websocket-version', '13'], ['sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ==']
		] : [])
	];
}

await assertPortFree(port);
const proc = Bun.spawn([process.execPath, buildPath()], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(port) }), stdout: 'pipe', stderr: 'pipe'
});
let checks = 0;
try {
	await waitForServer(proc, port);
	for (const route of routes) {
		const control = await rawExchange(port, fields(route), route);
		assert.equal(control.status, route.accepted, route.name + ' valid control');
		assert.equal(control.headers['x-hook-routed'], '1');
		checks++;
		for (const [name, value, repeated] of cases) {
			const common = fields(route).filter(([field]) => field !== name);
			const single = await rawExchange(port, [...common, [name, value]], route);
			const multiple = await rawExchange(port, [...common, ...repeated.map(part => [name, part])], route);
			const refused = name === 'origin' && route.originGate;
			assert.equal(single.status, refused ? 403 : route.accepted, `${route.name} single ${name}`);
			assert.equal(multiple.status, single.status, `${route.name} repeated ${name}`);
			for (const response of [single, multiple]) {
				assert.equal(response.headers['x-hook-routed'], refused ? undefined : '1');
				assert.equal(response.headers['x-observed-' + name], refused ? undefined : value);
			}
			checks += 2;
		}
		const duplicateHost = await rawExchange(port, [...fields(route), ['host', 'other.example']], route);
		assert.equal(duplicateHost.status, 400, route.name + ' repeated Host still rejected');
		checks++;
	}
	const admin = routes.find(route => route.name === 'admin');
	const denied = await rawExchange(port, fields(admin).filter(([name]) => name !== 'authorization'), admin);
	assert.equal(denied.status, 401, 'normalized values do not authorize the admin route');
	assert.equal(denied.headers['x-hook-routed'], undefined);
	checks++;
	console.log(`${checks} raw TCP identity-header normalization and route-policy checks passed`);
} finally { proc.kill(); await proc.exited; }

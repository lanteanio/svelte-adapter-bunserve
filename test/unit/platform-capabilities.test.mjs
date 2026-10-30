import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
	assertPlatformContract, definePlatformContract, INVALID_PLATFORM_CONTRACT, PLATFORM_ACTIVATION_FAILED,
	PLATFORM_CONTRACT, PLATFORM_MEMBERS, TEST_PLATFORM_CONTRACT
} from '../../src/platform-contract.js';

globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform: productionPlatform } = await import('../../src/runtime/handler/platform.js');

const root = fileURLToPath(new URL('../../', import.meta.url));
const define = members => definePlatformContract({ schemaVersion: 1, adapter: 'example-adapter', members });
const failure = (fn) => {
	try { fn(); } catch (error) { return error; }
	assert.fail('expected a throw');
};

test('validates a positive alternate contract without inferring an adapter from absent methods', () => {
	const contract = define({ publish: { kind: 'function', context: 'worker' }, traceContext: { kind: 'object|null', context: 'worker' } });
	let calls = 0;
	const platform = { publish() { calls++; }, traceContext: null };
	assert.doesNotThrow(() => assertPlatformContract(platform, contract, { context: 'worker' }));
	assert.equal(calls, 0);
	for (const name of ['batch', 'request', 'requestTopic']) assert.equal(name in platform, false);
	assert.throws(() => assertPlatformContract(platform, PLATFORM_CONTRACT, { context: 'worker' }), /adviseReconnect: missing function/);
	assert.equal(Object.isFrozen(contract), true);
	assert.equal(Object.isFrozen(contract.members), true);
	assert.equal(Object.isFrozen(contract.members.publish), true);
});

test('aggregates failures in name order without exposing values or getter exceptions', () => {
	const contract = define({ z: { kind: 'string', context: 'worker' }, b: { kind: 'function', context: 'worker' }, a: { kind: 'object|null', context: 'worker' } });
	let calls = 0;
	const source = { b: 'private-token', get a() { calls++; throw new Error('secret exception'); } };
	assert.throws(() => assertPlatformContract(source, contract, { context: 'worker' }), {
		message: 'Platform activation failed for example-adapter (worker): a: unreadable; expected object|null; b: expected function; z: missing string. Supply the complete platform or the explicit contract declared by its adapter.'
	});
	assert.equal(calls, 1);
});

test('checks inherited worker members in connection context and keeps getter receivers live', () => {
	const contract = define({ connections: { kind: 'number', context: 'worker' }, requestId: { kind: 'string', context: 'connection' } });
	let reads = 0;
	const base = { count: 2, get connections() { reads++; return this.count; } };
	assert.doesNotThrow(() => assertPlatformContract(base, contract, { context: 'worker' }));
	const connection = Object.assign(Object.create(base), { count: 3, requestId: 'one' });
	assert.doesNotThrow(() => assertPlatformContract(connection, contract, { context: 'connection' }));
	connection.count = 'private';
	assert.throws(() => assertPlatformContract(connection, contract, { context: 'connection' }), /connections: expected number/);
	assert.equal(reads, 3);
	delete connection.requestId;
	assert.throws(() => assertPlatformContract(connection, contract, { context: 'connection' }), /requestId: missing string/);
});

const invalidContracts = [
	{ schemaVersion: 2, adapter: 'example', members: {} },
	{ schemaVersion: 1, adapter: 'private token', members: {} },
	{ schemaVersion: 1, adapter: 'example', members: { send: { kind: 'callable', context: 'worker' } } },
	{ schemaVersion: 1, adapter: 'example', members: { send: { kind: 'function', context: 'request' } } },
	{ schemaVersion: 1, adapter: 'example', members: { send: { kind: 'function', context: 'worker', extra: true } } },
	{ schemaVersion: 1, adapter: 'example', get members() { throw new Error('must not read getter'); } }
];
for (const [index, contract] of invalidContracts.entries()) {
	test('rejects invalid schema before probing platform values: ' + index, () => {
		let probes = 0;
		const platform = new Proxy({}, { get() { probes++; }, has() { probes++; } });
		assert.throws(() => assertPlatformContract(platform, contract, { context: 'worker' }), /^TypeError: Invalid platform contract:/);
		assert.equal(probes, 0);
	});
}

test('the production worker platform and its connection clone satisfy the production contract', () => {
	assert.doesNotThrow(() => assertPlatformContract(productionPlatform, PLATFORM_CONTRACT, { context: 'worker' }));
	// The per-connection platform is a prototype-linked clone carrying requestId.
	const connection = Object.assign(Object.create(productionPlatform), { requestId: 'connection-request' });
	assert.doesNotThrow(() => assertPlatformContract(connection, PLATFORM_CONTRACT, { context: 'connection' }));
	assert.throws(() => assertPlatformContract(productionPlatform, PLATFORM_CONTRACT, { context: 'connection' }), {
		code: PLATFORM_ACTIVATION_FAILED,
		failures: [{ member: 'requestId', problem: 'missing', expected: 'string' }]
	});
});

test('the contracts declare exactly the inventory, less the sampler subscriptions for the test server', () => {
	assert.deepEqual(Object.keys(PLATFORM_CONTRACT.members), [...PLATFORM_MEMBERS]);
	assert.deepEqual(Object.keys(TEST_PLATFORM_CONTRACT.members), PLATFORM_MEMBERS.filter(name => name !== 'onPressure' && name !== 'onPublishRate'));
	assert.equal(PLATFORM_CONTRACT.adapter, 'svelte-adapter-bunserve');
	assert.equal(TEST_PLATFORM_CONTRACT.adapter, 'svelte-adapter-bunserve/testing');
	assert.deepEqual(PLATFORM_CONTRACT.members.requestId, { kind: 'string', context: 'connection' });
	assert.deepEqual(PLATFORM_CONTRACT.members.metrics, { kind: 'object|null', context: 'worker' });
	assert.deepEqual(PLATFORM_CONTRACT.members.hlc, { kind: 'function', context: 'worker' });
	for (const name of ['batch', 'request', 'requestTopic', 'trace', 'traceContext', 'introspect', 'diagnostic']) {
		assert.equal(Object.hasOwn(PLATFORM_CONTRACT.members, name), false, name);
	}
});

test('accepts a callable where the contract declares an object, never a primitive or a plain object for a function', () => {
	const registry = Object.assign(function metricsRegistry() {}, { counter() {} });
	assert.doesNotThrow(() => assertPlatformContract({ metrics: registry }, define({ metrics: { kind: 'object|null', context: 'worker' } }), { context: 'worker' }));
	assert.throws(() => assertPlatformContract({ metrics: 1 }, define({ metrics: { kind: 'object|null', context: 'worker' } }), { context: 'worker' }),
		/metrics: expected object\|null/);
	assert.throws(() => assertPlatformContract({ publish: {} }, define({ publish: { kind: 'function', context: 'worker' } }), { context: 'worker' }),
		/publish: expected function/);
});

for (const canonical of [PLATFORM_CONTRACT, TEST_PLATFORM_CONTRACT]) {
	for (const change of ['missing', 'kind', 'context']) {
		test('refuses a reduced reserved contract before probing: ' + canonical.adapter + ' ' + change, () => {
			const members = { ...canonical.members, publish: { ...canonical.members.publish } };
			if (change === 'missing') delete members.publish;
			else if (change === 'kind') members.publish.kind = 'object';
			else members.publish.context = 'connection';
			let probes = 0;
			const source = new Proxy({}, { get() { probes++; }, has() { probes++; } });
			assert.throws(() => assertPlatformContract(source, { ...canonical, members }, { context: 'worker' }),
				/^TypeError: Invalid platform contract: reserved adapter .* requires canonical member declarations: publish/);
			assert.equal(probes, 0);
		});
	}
}

test('runs the documented wrapper and preserves live getters, method receivers and explicit association', () => {
	const markdown = readFileSync(new URL('../../docs/platform-contract.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
	const blocks = [...markdown.matchAll(/```js\n([\s\S]*?)```/g)].map(match => match[1].replace(/^export /gm, ''));
	assert.equal(blocks.length, 2);
	const result = execFileSync(process.execPath, ['--input-type=module', '-e', blocks.join('\n') + `
const source = { value: 1, publish() { return this.value; }, get traceContext() { return this.value ? { version: this.value } : null; } };
const wrapped = forwardPlatform(source, contract, 'worker');
source.value = 2;
const published = wrapped.platform.publish();
const context = wrapped.platform.traceContext;
source.value = 0;
console.log(JSON.stringify({ associated: wrapped.contract === contract, published, context, cleared: wrapped.platform.traceContext }));
`], { cwd: root, encoding: 'utf8', timeout: 10000 });
	assert.deepEqual(JSON.parse(result), { associated: true, published: 2, context: { version: 2 }, cleared: null });
});

test('gives both failure kinds a stable code and the activation error its failures', () => {
	const invalid = failure(() => definePlatformContract({ schemaVersion: 2, adapter: 'example', members: {} }));
	assert.ok(invalid instanceof TypeError);
	assert.equal(invalid.code, INVALID_PLATFORM_CONTRACT);
	const contract = define({ b: { kind: 'function', context: 'worker' }, a: { kind: 'number', context: 'worker' }, c: { kind: 'string', context: 'worker' } });
	const activation = failure(() => assertPlatformContract({ b: 1, get a() { throw new Error('secret'); } }, contract, { context: 'worker' }));
	assert.ok(activation instanceof TypeError);
	assert.equal(activation.code, PLATFORM_ACTIVATION_FAILED);
	assert.equal(activation.adapter, 'example-adapter');
	assert.equal(activation.context, 'worker');
	assert.deepEqual(activation.failures, [
		{ member: 'a', problem: 'unreadable', expected: 'number' },
		{ member: 'b', problem: 'wrong-kind', expected: 'function' },
		{ member: 'c', problem: 'missing', expected: 'string' }
	]);
	assert.equal(Object.isFrozen(activation.failures) && Object.isFrozen(activation.failures[0]), true);
	assert.ok(!JSON.stringify(activation.failures).includes('secret'));
	assert.equal(INVALID_PLATFORM_CONTRACT, 'INVALID_PLATFORM_CONTRACT');
	assert.equal(PLATFORM_ACTIVATION_FAILED, 'PLATFORM_ACTIVATION_FAILED');
});

test('does not count Object.prototype members as platform capabilities', () => {
	const contract = define({ toString: { kind: 'function', context: 'worker' }, hasOwnProperty: { kind: 'function', context: 'worker' } });
	assert.throws(() => assertPlatformContract({}, contract, { context: 'worker' }), /toString: missing function/);
	assert.throws(() => assertPlatformContract(() => {}, define({ call: { kind: 'function', context: 'worker' } }), { context: 'worker' }), /call: missing function/);
	// An own or inherited non-built-in definition still counts.
	const base = { toString() { return 'platform'; }, hasOwnProperty() { return true; } };
	assert.doesNotThrow(() => assertPlatformContract(Object.create(base), contract, { context: 'worker' }));
});

test('reserves the whole svelte-adapter-bunserve namespace and refuses malformed names', () => {
	for (const adapter of ['svelte-adapter-bunserve', 'svelte-adapter-bunserve/vite', 'svelte-adapter-bunserve/testing/extra', 'svelte-adapter-bunserve/', 'example//x', '/example', 'Example']) {
		assert.throws(() => definePlatformContract({ schemaVersion: 1, adapter, members: {} }), /^TypeError: Invalid platform contract:/, adapter);
	}
	for (const adapter of ['@scope/adapter', '@scope/adapter/testing', 'svelte-adapter-uws', 'svelte-adapter-uws/testing', 'svelte-adapter-bunserve-extensions']) {
		assert.doesNotThrow(() => definePlatformContract({ schemaVersion: 1, adapter, members: {} }), adapter);
	}
});

test('returns an already defined declaration as is, without validating it again', () => {
	assert.equal(definePlatformContract(PLATFORM_CONTRACT), PLATFORM_CONTRACT);
	const own = define({ publish: { kind: 'function', context: 'worker' } });
	assert.equal(definePlatformContract(own), own);
	// A copy is not a declaration this module produced: it is validated afresh.
	assert.notEqual(definePlatformContract({ ...own }), own);
});

test('refuses to generate an optional Platform member as a required capability', { timeout: 60000 }, () => {
	const temp = mkdtempSync(join(root, 'test', '.generate-'));
	try {
		cpSync(join(root, 'src'), join(temp, 'src'), { recursive: true });
		mkdirSync(join(temp, 'scripts'));
		cpSync(join(root, 'scripts', 'generate-platform-contract.js'), join(temp, 'scripts', 'generate-platform-contract.js'));
		const declaration = readFileSync(join(temp, 'src', 'index.d.ts'), 'utf8');
		const marker = 'export interface Platform {';
		assert.equal(declaration.split(marker).length, 2);
		writeFileSync(join(temp, 'src', 'index.d.ts'), declaration.replace(marker, marker + '\n\tmaybeLater?(): void;'));
		const run = spawnSync(process.execPath, ['scripts/generate-platform-contract.js', '--check'], { cwd: temp, encoding: 'utf8' });
		assert.notEqual(run.status, 0);
		assert.ok(run.stderr.includes('Platform member maybeLater is optional; define its contract policy in the generator.'), run.stderr);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test('accepts a forwarding Proxy through its has trap, except for built-in prototype names', () => {
	const source = { publish() { return 'sent'; } };
	const forward = new Proxy({}, { has: (_target, name) => name in source, get: (_target, name) => source[name] });
	assert.doesNotThrow(() => assertPlatformContract(forward, define({ publish: { kind: 'function', context: 'worker' } }), { context: 'worker' }));
	assert.throws(() => assertPlatformContract(forward, define({ batch: { kind: 'function', context: 'worker' } }), { context: 'worker' }), /batch: missing function/);
	// A has trap that claims everything cannot satisfy a name Object.prototype carries.
	const claimsAll = new Proxy({}, { has: () => true, get: () => () => {} });
	assert.throws(() => assertPlatformContract(claimsAll, define({ toString: { kind: 'function', context: 'worker' } }), { context: 'worker' }), /toString: missing function/);
});

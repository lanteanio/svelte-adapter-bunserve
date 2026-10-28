import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { publicDeclarationSignatures } from '../../probe/type-signatures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('client exports and member declarations match the pinned lead contract', () => {
	const surface = JSON.parse(readFileSync(new URL('../../probe/uws-surface.json', import.meta.url), 'utf8'));
	const declarations = readFileSync(new URL('../../src/client.d.ts', import.meta.url), 'utf8');
	assert.match(surface.clientContract.commit, /^[0-9a-f]{40}$/);
	assert.deepEqual(publicDeclarationSignatures(declarations), surface.clientContract.declarations);
});

test('client entry stays inert during SSR without an explicit URL', { timeout: 15000 }, () => {
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		let calls = 0;
		globalThis.WebSocket = class { static OPEN = 1; constructor() { calls++; throw new Error('SSR socket'); } };
		globalThis.fetch = () => { calls++; throw new Error('SSR fetch'); };
		globalThis.setTimeout = globalThis.setInterval = () => { calls++; throw new Error('SSR timer'); };
		const { connect, ready } = await import('svelte-adapter-bunserve/client');
		const connection = connect({ auth: true });
		assert.equal(connection.send({ value: 1 }), false);
		connection.sendQueued({ value: 2 });
		connection.simulateOffline(); connection.resumeOnline();
		await ready();
		connection.close(); connection.resumeOnline();
		assert.equal(calls, 0);
	`], { cwd: root, encoding: 'utf8', timeout: 10000 });
	assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('client public entry bundles for the browser without server dependencies', async () => {
	const result = await build({
		absWorkingDir: root,
		stdin: { contents: "export * from 'svelte-adapter-bunserve/client';", resolveDir: root },
		bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true
	});
	assert.ok(result.outputFiles[0].text.includes('simulateOffline'));
	assert.ok(result.outputFiles[0].text.includes('resumeOnline'));
	assert.equal(Object.keys(result.metafile.inputs).some(path => /runtime\/handler\//.test(path)), false);
});

test('client package declarations typecheck consumer admission and offline controls', { timeout: 30000 }, () => {
	const require = createRequire(import.meta.resolve('@arethetypeswrong/core'));
	const ts = require('typescript');
	const entry = fileURLToPath(new URL('../types/client.ts', import.meta.url));
	const program = ts.createProgram([entry], {
		strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true
	});
	assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

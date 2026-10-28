import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('plain consumers import a frozen inventory through the supported package subpath', () => {
	const contract = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
		import { PLATFORM_MEMBERS } from 'svelte-adapter-bunserve/platform-contract';
		console.log(JSON.stringify({ members: PLATFORM_MEMBERS, frozen: Object.isFrozen(PLATFORM_MEMBERS) }));
	`], { cwd: root, encoding: 'utf8', timeout: 10000 }));
	assert.equal(contract.frozen, true);
	assert.deepEqual(contract.members, [...new Set(contract.members)].sort());
	assert.ok(contract.members.includes('requestId'));
	assert.ok(contract.members.includes('publishWireBatch'));
	assert.ok(!contract.members.includes('request'));
});

test('generated inventory follows the complete public Platform declaration', () => {
	execFileSync(process.execPath, ['scripts/generate-platform-contract.js', '--check'], {
		cwd: root, encoding: 'utf8', timeout: 10000
	});
});

test('consumer member types exactly match Platform keys and reject unsupported capabilities', { timeout: 30000 }, () => {
	const entry = fileURLToPath(new URL('../types/platform-contract.ts', import.meta.url));
	const program = ts.createProgram([entry], {
		strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

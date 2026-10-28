import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declarationSignatures, interfaceMethodContracts } from '../../probe/type-signatures.mjs';
import { wsFacade } from '../../src/runtime/handler/ws-facade.js';
import { KNOWN_ADAPTER_OPTIONS } from '../../src/adapter-options.js';
import { KNOWN_WS_OPTION_KEYS, INERT_WS_OPTION_KEYS } from '../../src/runtime/utils/ws-options.js';

const require = createRequire(import.meta.resolve('@arethetypeswrong/core'));
const ts = require('typescript');
const printer = ts.createPrinter({ removeComments: true });
const manifest = JSON.parse(readFileSync(new URL('../../probe/uws-surface.json', import.meta.url), 'utf8'));
const declarations = declarationSignatures(readFileSync(new URL('../../src/index.d.ts', import.meta.url), 'utf8'));
globalThis.ENV_PREFIX = '';
globalThis.WS_OPTIONS = null;
globalThis.WS_PATH = '/ws';
const { platform } = await import('../../src/runtime/handler/platform.js');

function canonical(text, keep) {
	const source = ts.createSourceFile('index.d.ts', text, ts.ScriptTarget.Latest, true);
	let node = source.statements[0];
	if (keep) node = ts.factory.updateInterfaceDeclaration(node, node.modifiers, node.name, node.typeParameters,
		node.heritageClauses, node.members.filter(member => keep(member.name?.getText(source))));
	const expanded = ts.transform(node, [context => {
		const visit = current => {
			if (ts.isTypeReferenceNode(current)) {
				const reference = manifest.typeReferences[current.typeName.getText(source)];
				if (reference) {
					const parsed = ts.createSourceFile('reference.d.ts', reference, ts.ScriptTarget.Latest, true);
					return ts.factory.createTypeLiteralNode(parsed.statements[0].members);
				}
			}
			return ts.visitEachChild(current, visit, context);
		};
		return visit;
	}]);
	try {
		return printer.printNode(ts.EmitHint.Unspecified, expanded.transformed[0], source).replace(/\s+/g, ' ').trim();
	} finally {
		expanded.dispose();
	}
}

test('published root declarations preserve the pinned lead signatures for implemented members', () => {
	const platformNames = new Set([...Object.keys(platform), 'requestId']);
	const wsNames = new Set([...KNOWN_WS_OPTION_KEYS].filter(name => !INERT_WS_OPTION_KEYS.has(name)));
	const selectors = {
		Platform: name => platformNames.has(name),
		AdapterOptions: name => KNOWN_ADAPTER_OPTIONS.includes(name),
		WebSocketOptions: name => wsNames.has(name)
	};
	assert.ok(Object.keys(manifest.typeDeclarations).length >= 20);
	for (const [name, declaration] of Object.entries(declarations)) {
		if (name === 'WebSocket') continue;
		assert.ok(manifest.typeDeclarations[name], `${name} is declared by the lead`);
		assert.equal(canonical(declaration), canonical(manifest.typeDeclarations[name], selectors[name]), name);
	}
});

test('socket declarations cover every facade method with the native return type and optional arity', () => {
	const methods = interfaceMethodContracts(declarations.WebSocket, 'WebSocket');
	const descriptors = Object.getOwnPropertyDescriptors(wsFacade({ readyState: 1, subscriptions: [] }));
	const names = Object.entries(descriptors)
		.filter(([name, descriptor]) => !name.startsWith('_') && typeof descriptor.value === 'function')
		.map(([name]) => name).sort();
	assert.deepEqual(Object.keys(methods).sort(), names);
	assert.ok(Object.keys(manifest.webSocketContract.methods).length >= names.length);
	for (const name of names) assert.deepEqual(methods[name], manifest.webSocketContract.methods[name], name);
});

test('consumer types accept hook contracts and reject unsupported APIs and invalid arguments', { timeout: 30000 }, () => {
	const entry = fileURLToPath(new URL('../types/contracts.ts', import.meta.url));
	const program = ts.createProgram([entry], {
		strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

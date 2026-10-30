#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const declarationPath = fileURLToPath(new URL('src/index.d.ts', root));
const program = ts.createProgram([declarationPath], { strictNullChecks: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext });
const source = program.getSourceFile(declarationPath);
const checker = program.getTypeChecker();
const interfaces = source.statements.filter((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'Platform');
if (interfaces.length !== 1 || interfaces[0].heritageClauses?.length) {
	throw new Error('Platform must be one complete interface; update the inventory generator for merged or inherited declarations.');
}
const members = [...new Set(interfaces[0].members.map((member) => {
	if (!member.name || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) {
		throw new Error('Platform contains an unnamed or computed member; define its inventory policy.');
	}
	return member.name.text;
}))].sort();
if (members.length === 0) {
	throw new Error('Platform inventory must contain unique named members.');
}
function valueKind(type) {
	if (type.isUnion()) {
		const kinds = [...new Set(type.types.map(valueKind))];
		if (kinds.length === 1) return kinds[0];
		if (kinds.length === 2 && kinds.includes('null')) return kinds.find(kind => kind !== 'null') + '|null';
		throw new Error('Platform member has an unsupported runtime-kind union.');
	}
	if (type.flags & ts.TypeFlags.Null) return 'null';
	if (type.flags & ts.TypeFlags.StringLike) return 'string';
	if (type.flags & ts.TypeFlags.NumberLike) return 'number';
	if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
	if (type.getCallSignatures().length) return 'function';
	if (type.flags & ts.TypeFlags.Object) return 'object';
	throw new Error('Platform member has an unsupported runtime kind: ' + checker.typeToString(type));
}
const testingDeclaration = readFileSync(new URL('src/testing.d.ts', root), 'utf8');
const testingSource = ts.createSourceFile('testing.d.ts', testingDeclaration, ts.ScriptTarget.Latest, true);
function omittedNames(typeNode, label) {
	const nodes = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode];
	return new Set(nodes.map(node => {
		if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal) || !members.includes(node.literal.text)) {
			throw new Error(label + ' omits an unknown Platform member.');
		}
		return node.literal.text;
	}));
}
// The worker platform type omits exactly the connection-scoped members, so the
// declaration users see in hook signatures is the single source of that scope.
const workerPlatform = testingSource.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'TestPlatform');
const workerBase = workerPlatform?.heritageClauses?.length === 1 && workerPlatform.heritageClauses[0].types.length === 1
	? workerPlatform.heritageClauses[0].types[0] : null;
if (!workerBase || workerBase.expression.getText(testingSource) !== 'Omit' ||
	workerBase.typeArguments?.length !== 2 || workerBase.typeArguments[0].getText(testingSource) !== 'TestConnectionPlatform') {
	throw new Error('TestPlatform must extend Omit<TestConnectionPlatform, ...> naming its connection-scoped members.');
}
const connectionScoped = omittedNames(workerBase.typeArguments[1], 'TestPlatform');
const requirements = new Map();
for (const member of interfaces[0].members) {
	const name = member.name.text;
	// An optional member is one an adapter may leave out; the contract has no
	// spelling for that, so it must be decided here rather than generated as required.
	if (member.questionToken) throw new Error('Platform member ' + name + ' is optional; define its contract policy in the generator.');
	const kind = ts.isMethodSignature(member) ? 'function' : valueKind(checker.getTypeAtLocation(member));
	const requirement = { kind, context: connectionScoped.has(name) ? 'connection' : 'worker' };
	if (requirements.has(name) && JSON.stringify(requirements.get(name)) !== JSON.stringify(requirement)) {
		throw new Error('Platform overload kinds disagree: ' + name);
	}
	requirements.set(name, requirement);
}
const testPlatform = testingSource.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'TestConnectionPlatform');
if (!testPlatform || !ts.isTypeReferenceNode(testPlatform.type) || testPlatform.type.typeName.getText(testingSource) !== 'Omit' ||
	testPlatform.type.typeArguments?.[0].getText(testingSource) !== 'Platform') {
	throw new Error('TestConnectionPlatform must declare its omitted Platform capabilities explicitly.');
}
const excluded = omittedNames(testPlatform.type.typeArguments[1], 'TestConnectionPlatform');
const entries = members.map(member => `\t${JSON.stringify(member)}`).join(',\n');
const notice = '// Generated from src/index.d.ts and src/testing.d.ts by scripts/generate-platform-contract.js.\n';
const documentation = '/**\n * All public Platform member names, including per-request and per-connection\n * context fields. This inventory describes the Bun contract, not the\n * capabilities implemented by another adapter or an arbitrary platform object.\n */\n';
function contractData(adapter, names) {
	const entries = names.map(member => `\t\t${JSON.stringify(member)}: ${JSON.stringify(requirements.get(member))}`).join(',\n');
	return `{\n\tschemaVersion: 1,\n\tadapter: ${JSON.stringify(adapter)},\n\tmembers: {\n${entries}\n\t}\n}`;
}
const privateData = notice +
	'const production = ' + contractData('svelte-adapter-bunserve', members) + ';\n\n' +
	'const testing = ' + contractData('svelte-adapter-bunserve/testing', members.filter(member => !excluded.has(member))) + ';\n\n' +
	'for (const contract of [production, testing]) {\n\tfor (const requirement of Object.values(contract.members)) Object.freeze(requirement);\n\tObject.freeze(contract.members);\n\tObject.freeze(contract);\n}\n\n' +
	'export const CANONICAL_PLATFORM_CONTRACTS = Object.freeze({\n\t"svelte-adapter-bunserve": production,\n\t"svelte-adapter-bunserve/testing": testing\n});\n';
const exports = "export { definePlatformContract, assertPlatformContract, INVALID_PLATFORM_CONTRACT, PLATFORM_ACTIVATION_FAILED } from './platform-contract-validation.js';\n";
const outputs = new Map([
	['src/runtime/platform-contract-data.js', privateData],
	['src/platform-contract.js', notice + "import { definePlatformContract } from './platform-contract-validation.js';\nimport { CANONICAL_PLATFORM_CONTRACTS } from './runtime/platform-contract-data.js';\n" + exports + '\n' + documentation +
		'export const PLATFORM_MEMBERS = Object.freeze([\n' + entries + '\n]);\n\n' +
		'/** Complete production platform requirements, including connection context. */\n' + 'export const PLATFORM_CONTRACT = definePlatformContract(CANONICAL_PLATFORM_CONTRACTS[\'svelte-adapter-bunserve\']);\n' + '\n' +
		'/** Capabilities supplied by the in-process test server. */\n' + 'export const TEST_PLATFORM_CONTRACT = definePlatformContract(CANONICAL_PLATFORM_CONTRACTS[\'svelte-adapter-bunserve/testing\']);\n'],
	['src/platform-contract.d.ts', notice + "import type { PlatformContract, PlatformMemberRequirement } from './platform-contract-validation.js';\n" + exports +
		"export type { PlatformContract, PlatformMemberRequirement, PlatformValueKind, PlatformActivationError, PlatformActivationFailure } from './platform-contract-validation.js';\n\n" + documentation +
		'export declare const PLATFORM_MEMBERS: readonly [\n' + entries + '\n];\n\n/** A public Platform member name. */\nexport type PlatformMember = typeof PLATFORM_MEMBERS[number];\n\n' +
		'/** Complete production platform requirements, including connection context. */\nexport declare const PLATFORM_CONTRACT: PlatformContract & { readonly members: Readonly<Record<PlatformMember, PlatformMemberRequirement>> };\n\n' +
		'/** Capabilities supplied by the in-process test server. */\nexport declare const TEST_PLATFORM_CONTRACT: PlatformContract & { readonly members: Readonly<Record<Exclude<PlatformMember, ' + [...excluded].sort().map(member => JSON.stringify(member)).join(' | ') + '>, PlatformMemberRequirement>> };\n']
]);
for (const [relative, expected] of outputs) {
	const target = new URL(relative, root);
	if (process.argv.includes('--check')) {
		let actual;
		try { actual = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch { actual = ''; }
		if (actual !== expected) {
			console.error(fileURLToPath(target) + ' is stale; run node scripts/generate-platform-contract.js');
			process.exitCode = 1;
		}
	} else writeFileSync(target, expected);
}
if (!process.exitCode) console.log('platform-contract: ' + members.length + ' public members');

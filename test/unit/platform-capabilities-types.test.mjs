import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('shares typed capability declarations between adapters and consumers', { timeout: 60000 }, () => {
	const fixture = fileURLToPath(new URL('./platform-capabilities-consumer.mts', import.meta.url));
	const source = `
import {
	PLATFORM_CONTRACT, TEST_PLATFORM_CONTRACT, definePlatformContract, assertPlatformContract,
	INVALID_PLATFORM_CONTRACT, PLATFORM_ACTIVATION_FAILED,
	type PlatformContract, type PlatformValueKind, type PlatformMemberRequirement,
	type PlatformActivationError, type PlatformActivationFailure
} from '../../src/platform-contract.js';
const alternate = definePlatformContract({ schemaVersion: 1, adapter: 'example-adapter', members: {
	publish: { kind: 'function', context: 'worker' },
	requestId: { kind: 'string', context: 'connection' }
} });
const adapter: 'example-adapter' = alternate.adapter;
const contracts: PlatformContract[] = [PLATFORM_CONTRACT, TEST_PLATFORM_CONTRACT, alternate];
const kind: PlatformValueKind = alternate.members.publish.kind;
for (const contract of contracts) assertPlatformContract({}, contract, { context: 'worker' });
const invalidCode: 'INVALID_PLATFORM_CONTRACT' = INVALID_PLATFORM_CONTRACT;
const activationCode: 'PLATFORM_ACTIVATION_FAILED' = PLATFORM_ACTIVATION_FAILED;
declare const activation: PlatformActivationError;
const failures: readonly PlatformActivationFailure[] = activation.failures;
const problem: 'missing' | 'unreadable' | 'wrong-kind' = failures[0].problem;
declare const shared: PlatformContract;
const maybeBatch: PlatformMemberRequirement | undefined = shared.members.batch;
// @ts-expect-error An arbitrary adapter contract may not support this member.
shared.members.batch.kind;
// @ts-expect-error The positive alternate declaration has no batch capability.
alternate.members.batch;
const productionPublish: PlatformMemberRequirement = PLATFORM_CONTRACT.members.publish;
// @ts-expect-error The testing declaration does not advertise sampler subscriptions.
const testSampler: PlatformMemberRequirement = TEST_PLATFORM_CONTRACT.members.onPressure;
// @ts-expect-error Explicit positive entries cannot be undefined.
definePlatformContract({ schemaVersion: 1, adapter: 'example', members: { send: undefined } });
// @ts-expect-error Context must be explicit.
assertPlatformContract({}, alternate);
// @ts-expect-error Unsupported contexts cannot silently omit requirements.
assertPlatformContract({}, alternate, { context: 'request' });
// @ts-expect-error Member kinds are a shared closed vocabulary.
definePlatformContract({ schemaVersion: 1, adapter: 'example', members: { send: { kind: 'callable', context: 'worker' } } });
// @ts-expect-error Returned declarations are deeply read-only.
alternate.members.publish.kind = 'object';
`;
	const options = {
		strict: true, noEmit: true, skipLibCheck: true,
		module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022, types: []
	};
	const host = ts.createCompilerHost(options);
	const getSource = host.getSourceFile;
	const isFixture = path => path.replaceAll('\\', '/') === fixture.replaceAll('\\', '/');
	host.getSourceFile = (path, ...args) => isFixture(path)
		? ts.createSourceFile(path, source, options.target)
		: getSource(path, ...args);
	const program = ts.createProgram([fixture], options, host);
	const diagnostics = ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), {
		getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n'
	});
	assert.equal(diagnostics, '');
});

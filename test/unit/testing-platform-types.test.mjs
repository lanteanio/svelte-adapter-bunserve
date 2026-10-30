import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Type-check an in-memory consumer module placed next to this file.
 * @param {string} name
 * @param {string} source
 */
export function consumerDiagnostics(name, source) {
	const fixture = fileURLToPath(new URL('./' + name, import.meta.url));
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
	return ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), {
		getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n'
	});
}

test('types only the worker and connection capabilities the test server supplies', { timeout: 60000 }, () => {
	const source = `
import { createTestServer, type TestWebSocketHandler } from '../../src/testing.js';
const handler: TestWebSocketHandler<{ account: string }> = {
	init({ platform }) {
		const wall: number = platform.now();
		// @ts-expect-error Worker callbacks have no request ID.
		platform.requestId;
		// @ts-expect-error The test server has no pressure sampler.
		platform.onPressure(() => {});
	},
	shutdown({ platform }) {
		// @ts-expect-error Shutdown is worker scoped.
		platform.requestId;
	},
	message(ws, { platform }) {
		const id: string = platform.requestId;
		const account: string = ws.getUserData().account;
		const stamp: { wall: number; logical: number; nodeId: string } = platform.hlc();
		// @ts-expect-error Connection callbacks have no publish-rate sampler.
		platform.onPublishRate(() => {});
	}
};
await createTestServer({ handler });
const server = await createTestServer({ handler: {
	open(ws, { platform }) {
		const id: string = platform.requestId;
		const bytes: Uint8Array = platform.random.bytes(3);
		// @ts-expect-error Inferred callbacks also exclude pressure subscriptions.
		platform.onPressure(() => {});
	},
	init({ platform }) {
		// @ts-expect-error Inferred worker callbacks have no request ID.
		platform.requestId;
	}
} });
const wall: number = server.platform.now();
// @ts-expect-error The returned worker platform has no request ID.
server.platform.requestId;
// @ts-expect-error The returned worker platform has no sampler subscriptions.
server.platform.onPublishRate(() => {});
`;
	assert.equal(consumerDiagnostics('testing-platform-consumer.mts', source), '');
});

import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('types committed drain output and the untouched failure cause for a consumer', () => {
	const fixture = fileURLToPath(new URL('./smooth-drain-consumer.mts', import.meta.url));
	const source = `
import { createSmoothAuthority, SmoothDrainError, type SmoothDrainResult } from '../../src/plugins/smooth/server.js';
type State = { x: number };
const authority = createSmoothAuthority<State, number>({ apply: (state, delta) => ({ x: state.x + delta }) });
const result: SmoothDrainResult<State> = authority.drain();
const error = new SmoothDrainError<State>(undefined, result);
const x: number = error.partial.updates[0].state.x;
const code: 'SMOOTH_DRAIN_FAILED' = error.code;
// @ts-expect-error State remains typed through the error result.
const wrong: string = error.partial.acks[0].state.x;
try { authority.drain(); } catch (caught) {
	if (caught instanceof SmoothDrainError) {
		const partial: SmoothDrainResult = caught.partial;
		const cause: unknown = caught.cause;
		// @ts-expect-error Arbitrary thrown values are not necessarily Errors.
		const message: string = caught.cause.message;
	}
}
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
	const diagnostics = ts.getPreEmitDiagnostics(program);
	expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n'
	})).toBe('');
});

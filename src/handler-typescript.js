/** Compile TypeScript hooks when the Vite build plugin is not installed. */
export function handlerTypescript() {
	return {
		name: 'adapter-bunserve-handler-typescript',
		async transform(code, id) {
			if (!/\.[cm]?tsx?$/.test(id)) return null;
			const { transform } = await import('esbuild');
			const output = await transform(code, {
				loader: id.endsWith('tsx') ? 'tsx' : 'ts',
				format: 'esm', target: 'esnext', sourcefile: id, sourcemap: true
			});
			return { code: output.code, map: output.map };
		}
	};
}

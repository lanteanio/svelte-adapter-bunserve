/**
 * Resolve the build-injected `MANIFEST` specifier to the test stub, the same
 * technique as ws-handler-loader.mjs: outside a build nothing resolves the
 * specifier, so the static-asset and SSR handler modules would otherwise be
 * unreachable from unit tests.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const STUB = pathToFileURL(fileURLToPath(new URL('./manifest-stub.mjs', import.meta.url))).href;

/**
 * @param {string} specifier
 * @param {any} context
 * @param {any} next
 */
export async function resolve(specifier, context, next) {
	if (specifier === 'MANIFEST') return { url: STUB, shortCircuit: true };
	return next(specifier, context);
}

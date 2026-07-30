/**
 * Resolve the build-injected `WS_HANDLER` specifier to the test stub.
 *
 * `src/runtime/ws-handler-bridge.js` imports a bare specifier the build's
 * replace map rewrites to the generated handler path. Nothing resolves it
 * outside a build, so importing the platform from a unit test fails at module
 * resolution - which is why the authorization gate had no unit coverage and its
 * bypasses were only ever caught by review.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const STUB = pathToFileURL(fileURLToPath(new URL('./ws-handler-stub.mjs', import.meta.url))).href;

/**
 * @param {string} specifier
 * @param {any} context
 * @param {any} next
 */
export async function resolve(specifier, context, next) {
	if (specifier === 'WS_HANDLER') return { url: STUB, shortCircuit: true };
	return next(specifier, context);
}

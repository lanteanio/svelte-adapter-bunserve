/**
 * Module-resolution hook for the simulator: resolves the build-injected
 * `WS_HANDLER` specifier to sim-hooks.js, so the real handler dispatch can be
 * imported without a build. Registered by src/sim.js before it imports the
 * handler graph; Node-only (the golden gate runs under node, like the rest of
 * the unit lane).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = pathToFileURL(fileURLToPath(new URL('./sim-hooks.js', import.meta.url))).href;

/**
 * @param {string} specifier
 * @param {any} context
 * @param {any} next
 */
export async function resolve(specifier, context, next) {
	if (specifier === 'WS_HANDLER') return { url: HOOKS, shortCircuit: true };
	return next(specifier, context);
}

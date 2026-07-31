import process from 'node:process';

/* global ENV_PREFIX */

const expected = new Set([
	'HOST',
	'PORT',
	'ORIGIN',
	'XFF_DEPTH',
	'ADDRESS_HEADER',
	'TRUSTED_PROXIES',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'BODY_SIZE_LIMIT',
	'SHUTDOWN_TIMEOUT',
	'SHUTDOWN_DELAY_MS',
	'SHUTDOWN_RECONNECT_WINDOW_MS',
	'SSL_CERT',
	'SSL_KEY',
	'CLUSTER_WORKERS'
]);

// Every name the runtime reads through env() has to be listed above, or a
// prefixed deployment setting that documented variable is refused at boot as a
// conflicting one. Adding an env() call without adding its name here is the way
// that happens, which is what test/unit/env-names.test.mjs compares.

if (ENV_PREFIX) {
	for (const name in process.env) {
		if (name.startsWith(ENV_PREFIX)) {
			const unprefixed = name.slice(ENV_PREFIX.length);
			if (!expected.has(unprefixed)) {
				throw new Error(
					`You should change envPrefix (${ENV_PREFIX}) to avoid conflicts with existing environment variables - unexpectedly saw ${name}`
				);
			}
		}
	}
}

// IMPORTANT: process.env property access crosses the runtime-to-OS boundary on
// every call - it is NOT a cached Map lookup. All env() calls must be at module
// level, never inside request handlers.

/**
 * @param {string} name
 * @param {any} fallback
 */
export function env(name, fallback) {
	const prefixed = ENV_PREFIX + name;
	const value = process.env[prefixed];
	return value !== undefined ? value : fallback;
}

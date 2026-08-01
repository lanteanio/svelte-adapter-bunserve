// Shared spawn/wait plumbing for the live suites.
//
// It lives in one place because each suite had its own copy of the same twenty
// lines, and a copy is where a check quietly stops checking: one of them ended
// up with its dead-child guard inside the `try {} catch {}` that swallows fetch
// errors, so it could never fire.

import { fileURLToPath } from 'node:url';

/** Runtime environment variables that change how the built server behaves. */
const RUNTIME_ENV_KEYS = [
	'ORIGIN',
	'XFF_DEPTH',
	'ADDRESS_HEADER',
	'TRUSTED_PROXIES',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'BODY_SIZE_LIMIT',
	'IDLE_TIMEOUT',
	'SHUTDOWN_TIMEOUT',
	'SHUTDOWN_DELAY_MS',
	'SHUTDOWN_RECONNECT_WINDOW_MS',
	'SSL_CERT',
	'SSL_KEY',
	'CLUSTER_WORKERS',
	// Fixture-owned, not runtime-owned, but stripped for the same reason: left
	// exported in a shell it arms the never-settling shutdown hook in every
	// fixture server of every suite.
	'FIXTURE_HANG_SHUTDOWN'
];

/**
 * The environment a fixture server is started with: the caller's, minus every
 * variable the runtime reads, plus what this suite sets deliberately.
 *
 * Inheriting the shell wholesale means an exported SSL_CERT makes the server
 * speak TLS and every http:// probe in the suite fails, or an exported ORIGIN
 * 403s a handshake the suite expected to succeed. Those are false REDS rather
 * than false greens, but they get debugged as adapter bugs, and the build is
 * already pinned for the same reason.
 *
 * @param {Record<string, string>} own
 * @returns {Record<string, string | undefined>}
 */
export function serverEnv(own) {
	/** @type {Record<string, string | undefined>} */
	const env = { ...process.env };
	// undefined DELETES the key for Bun.spawn, where '' would leave it set and
	// the runtime would read an empty value rather than an absent one.
	for (const key of RUNTIME_ENV_KEYS) env[key] = undefined;
	return { ...env, ...own };
}

/**
 * Refuse to run when something is already serving the port.
 *
 * Without this a suite cannot tell its own server from someone else's. The
 * spawned process needs tens of milliseconds to boot and fail to bind, while a
 * leftover server answers in about one - so the wait loop below would be
 * satisfied by the stranger on its very first attempt, and the whole suite
 * would asserts against a build it did not produce and pass. An interrupted
 * run leaves exactly that behind, since killing the suite does not kill the
 * server it spawned.
 *
 * @param {number} port
 */
export async function assertPortFree(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
			signal: AbortSignal.timeout(1500)
		});
		throw Object.assign(
			new Error(
				`port ${port} is already serving (/healthz answered ${res.status}). That is almost ` +
				'certainly a fixture server left behind by an interrupted run - kill it and try again. ' +
				'Running against it would assert this suite on a build it never produced.'
			),
			{ portBusy: true }
		);
	} catch (err) {
		if (err && err.portBusy) throw err;
		// Anything else - connection refused, timeout - means the port is free,
		// which is what this needs.
	}
}

/**
 * Wait for the server this suite spawned, and fail fast when it dies.
 *
 * The dead-child test runs BEFORE the probe and outside any catch, so a server
 * that cannot start reports why in milliseconds instead of timing out ten
 * seconds later with `server never came up`.
 *
 * @param {any} proc
 * @param {number} port
 * @param {string} [probePath]
 */
export async function waitForServer(proc, port, probePath = '/healthz') {
	for (let i = 0; i < 100; i++) {
		if (proc.exitCode !== null) {
			throw new Error(`the fixture server exited with code ${proc.exitCode} before answering.`);
		}
		try {
			const res = await fetch(`http://127.0.0.1:${port}${probePath}`);
			if (res.ok) return;
		} catch {
			// Not up yet.
		}
		await Bun.sleep(100);
	}
	throw new Error(`the fixture server never answered on port ${port}`);
}

/**
 * The built fixture this suite drives.
 *
 * @param {string} [out] - the adapter's output directory
 */
export function buildPath(out = 'build') {
	return fileURLToPath(new URL(`../fixture/${out}/index.js`, import.meta.url));
}

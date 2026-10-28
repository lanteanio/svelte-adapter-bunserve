// Restore browser-shaped globals after each test file so mocks cannot leak
// into another suite when files execute serially.

import { afterAll } from 'vitest';

// Names a test file is known to install, plus the rest of the browser shims a
// client suite reaches for. Snapshotting a name that is absent is harmless: it
// is recorded as absent and deleted again on the way out.
const BROWSER_GLOBALS = [
	'WebSocket',
	'window',
	'document',
	'navigator',
	'localStorage',
	'sessionStorage',
	'devicePixelRatio',
	'requestAnimationFrame',
	'cancelAnimationFrame'
];

/** @type {Array<[string, boolean, unknown]>} */
const pristine = BROWSER_GLOBALS.map((key) => [
	key,
	key in globalThis,
	/** @type {any} */ (globalThis)[key]
]);

afterAll(() => {
	for (const [key, existed, value] of pristine) {
		if (existed) {
			if (/** @type {any} */ (globalThis)[key] !== value) {
				/** @type {any} */ (globalThis)[key] = value;
			}
		} else if (key in globalThis) {
			delete /** @type {any} */ (globalThis)[key];
		}
	}
});

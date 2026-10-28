import { env } from '$env/dynamic/private';

// What the extra server entries vite.config.js adds recorded when they ran -
// their names in the order they ran, whether the WebSocket handler module had
// loaded by then, and how much of the dynamic env they could see - beside how
// much of it a request sees now. `ran` is null when none ran, which is what an
// adapter that never imports them answers.
export function GET() {
	const ran = /** @type {any} */ (globalThis).__fixtureExtraEntries ?? null;
	return new Response(JSON.stringify({ ran, dynamicEnvKeysNow: Object.keys(env).length }), {
		headers: { 'content-type': 'application/json' }
	});
}

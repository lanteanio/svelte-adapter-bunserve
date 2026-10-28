// The WebSocket path's own route. A request there that is not a handshake is
// the app's, as svelte-adapter-uws yields it, so this answers with the method
// it saw and a header a HEAD carries too: test/live/ws-smoke.mjs,
// admission-check.mjs and no-ws-check.mjs read them to tell an answer from the
// app apart from one the adapter wrote.

/** @param {string} method */
function answer(method) {
	return new Response(`app ${method}`, {
		headers: { 'content-type': 'text/plain', 'x-app-route': 'ws' }
	});
}

export function GET() {
	return answer('GET');
}

export function POST() {
	return answer('POST');
}

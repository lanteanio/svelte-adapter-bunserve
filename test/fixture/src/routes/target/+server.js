// Answers with the query exactly as the app received it, so
// test/live/request-target-check.mjs can read what Bun made of raw bytes in a
// request target: the escapes the app's router sees in their place.

/** @param {{ url: URL }} event */
export function GET({ url }) {
	return new Response(url.search, { headers: { 'content-type': 'text/plain' } });
}

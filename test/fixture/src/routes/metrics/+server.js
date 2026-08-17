// The documented scrape route: an ordinary SvelteKit endpoint reading the
// adapter's own registry through `platform`.
//
// This is the whole reason the adapter owns the registry rather than importing
// one the app also imports. Measured on this fixture: a module imported by both
// a route and the WebSocket handler is TWO instances in the built output, so an
// app rendering its own copy would publish a registry the adapter never wrote
// to. Reaching it through `platform` is what makes there be exactly one.
export async function GET({ platform }) {
	return new Response(await platform.metricsSnapshot(), {
		headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }
	});
}

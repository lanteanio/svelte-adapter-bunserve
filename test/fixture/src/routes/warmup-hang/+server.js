// A route whose body NEVER ends, for test/live/warmup-check.mjs.
//
// The boot warmup drains a finite body so the render completes rather than
// parking half-done, and must NOT drain one like this: buffering it would await
// forever and hang readiness behind a route nobody is even asking for. It
// cancels instead - the headers and the first render already warmed the path.
//
// Reached only by the build-warmup-hang variant, which points `warmup.paths`
// here. Nothing else requests it.
export async function GET() {
	// Slow enough that the readiness poll in warmup-check.mjs observes the
	// `starting` window rather than racing past it. The warmup being fast is
	// the normal case and cannot be asserted against.
	await new Promise((r) => setTimeout(r, 400));
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode('data: open\n\n'));
			// And never again: no close, no error, no further enqueue.
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	});
}

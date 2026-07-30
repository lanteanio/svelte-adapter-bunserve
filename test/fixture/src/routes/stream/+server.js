// Streaming HTML: the shell goes out immediately, the rest only after a
// delay. Verifies the adapter forwards status, headers, and the first chunk
// without waiting for the second - the shape SvelteKit deferred data
// produces, and the one a second blocking read would stall.
export function GET() {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			controller.enqueue(encoder.encode('<html><body>shell'));
			await new Promise((r) => setTimeout(r, 1500));
			controller.enqueue(encoder.encode('<p>deferred</p></body></html>'));
			controller.close();
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'text/html' }
	});
}

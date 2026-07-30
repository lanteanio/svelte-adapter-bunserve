// Connect-then-silence event stream: one event immediately, then the stream
// stays open without further chunks. Verifies the adapter returns status,
// headers, and the first event promptly instead of waiting for a second chunk.
export function GET() {
	const encoder = new TextEncoder();
	let timer;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode('data: connected\n\n'));
			timer = setTimeout(() => {
				try { controller.close(); } catch { /* client already gone */ }
			}, 30000);
		},
		cancel() {
			clearTimeout(timer);
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	});
}

export function GET() {
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			for (let i = 0; i < 3; i++) {
				controller.enqueue(encoder.encode(`data: tick-${i}\n\n`));
				await new Promise((r) => setTimeout(r, 50));
			}
			controller.close();
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	});
}

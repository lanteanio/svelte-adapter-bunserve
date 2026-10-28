const records = new Map();
async function respond({ url }) {
	const id = url.searchParams.get('id');
	if (url.searchParams.has('inspect')) {
		const record = records.get(id);
		records.delete(id);
		return Response.json(record ?? null);
	}
	const record = { reads: 0, cancels: 0 };
	if (id) records.set(id, record);
	const stream = url.searchParams.has('stream');
	const headers = { 'content-type': 'text/plain' };
	if (url.searchParams.has('date')) headers.date = 'Sun, 06 Nov 1994 08:49:37 GMT';
	if (url.searchParams.has('length')) headers['content-length'] = stream ? '6' : '4096';
	const response = new Response(new ReadableStream({
		start(out) { out.enqueue(new TextEncoder().encode(stream ? 'start\n' : 'a'.repeat(4096))); },
		pull(out) { record.reads++; if (!stream) out.close(); },
		cancel() { record.cancels++; }
	}, { highWaterMark: 0 }), { headers });
	return response;
}
export const GET = respond;
export const HEAD = respond;

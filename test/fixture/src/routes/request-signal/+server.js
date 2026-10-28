async function respond({ request, url }) {
	const records = globalThis.__requestSignalRecords ??= new Map();
	const record = { signal: request.signal, ready: false, aborted: false };
	records.set(url.searchParams.get('id'), record);
	request.signal.addEventListener('abort', () => {
		record.aborted = true;
		record.reason = request.signal.reason;
	}, { once: true });
	if (request.method === 'POST' && !url.searchParams.has('unread')) {
		try { record.body = await request.text(); }
		catch (error) { record.bodyError = error; return new Response('aborted'); }
	}
	record.ready = true;
	if (url.searchParams.has('error')) return new Response(new ReadableStream({ pull() { throw new Error('fixture body failed'); } }));
	if (url.searchParams.has('stream')) {
		return new Response(new ReadableStream({ start(out) {
			record.output = out;
			out.enqueue(new TextEncoder().encode('start\n'));
		}, cancel() { record.cancelled = true; } }), { headers: url.searchParams.has('length') ? { 'content-type': 'text/plain', 'content-length': '6' } : { 'content-type': 'text/event-stream' } });
	}
	if (url.searchParams.has('hold')) await new Promise(resolve => { record.release = resolve; });
	return new Response('done');
}
export const GET = respond;
export const POST = respond;

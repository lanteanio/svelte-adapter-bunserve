const records = new Map();
globalThis.__responseContractRecords = records;
const encoder = new TextEncoder();

async function respond({ request, url }) {
	const id = url.searchParams.get('id') || '';
	const mode = url.searchParams.get('mode') || 'text';
	if (mode === 'inspect') {
		const record = records.get(id);
		return Response.json(record ? { pulls: record.pulls, cancels: record.cancels, locked: record.body?.locked ?? false } : null);
	}
	if (mode === 'release') { records.get(id)?.release?.(); return new Response('released'); }
	if (request.method === 'POST') await request.text();
	const record = { pulls: 0, cancels: 0, body: null, release: null };
	if (id) records.set(id, record);
	const headers = { 'content-type': mode.startsWith('sse') ? 'text/event-stream' : 'text/plain' };
	if (url.searchParams.has('te')) headers['transfer-encoding'] = 'chunked';
	if (url.searchParams.has('length')) headers['content-length'] = '4096';
	const gate = new Promise(resolve => { record.release = resolve; });
	let index = 0;
	const array = Uint8Array.from([90, 65, 66, 67, 68, 90]);
	const deferred = ['deferred', 'sse', 'cancel'].includes(mode) || mode.startsWith('sse-');
	let body = new ReadableStream({
		start(out) { if (deferred) out.enqueue(encoder.encode('shell\n')); },
		async pull(out) {
			record.pulls++;
			if (mode === 'first-deferred') { await gate; out.enqueue(encoder.encode('complete survivor')); out.close(); return; }
			if (mode.startsWith('sse-')) {
				await gate;
				if (mode === 'sse-bad' || mode === 'sse-bad-object') out.enqueue(mode === 'sse-bad' ? 42 : {});
				else { out.enqueue(new DataView(array.buffer, 1, 2)); out.enqueue(new Uint16Array(array.buffer, 2, 2)); out.enqueue('Gr' + String.fromCharCode(0xfc) + 'n'); out.close(); }
				return;
			}
			if (deferred) { await gate; out.enqueue(encoder.encode('tail\n')); out.close(); return; }
			if (mode === 'turns') { await new Promise(resolve => setImmediate(resolve)); if (index++ < 4) out.enqueue('turn\n'); else out.close(); return; }
			if (mode === 'cap') { if (index++ < 40) out.enqueue('x'.repeat(16 * 1024)); else { await gate; out.close(); } return; }
			if (mode === 'bad' || mode === 'bad-object') { out.enqueue(mode === 'bad' ? 42 : { invalid: true }); return; }
			if (mode === 'array') out.enqueue(array.buffer);
			else if (mode === 'views') { out.enqueue(new DataView(array.buffer, 1, 2)); out.enqueue(new Uint16Array(array.buffer, 2, 2)); }
			else out.enqueue('a'.repeat(4096));
			out.close();
		},
		cancel() { record.cancels++; if (mode === 'cancel') return new Promise(() => {}); }
	}, { highWaterMark: 0 });
	if (mode === 'transforms') for (let i = 0; i < 3; i++) body = body.pipeThrough(new TransformStream());
	if (mode === 'blob') body = new Blob(['a'.repeat(4096)]).stream();
	record.body = body;
	return new Response(body, { headers });
}
export const GET = respond;
export const HEAD = respond;
export const POST = respond;

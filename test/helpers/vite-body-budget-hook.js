const query = (target) => new URL(target, 'http://body-budget.invalid').searchParams;

// Marks the moment a hook hands its answer over, under the request's `id`.
function answered(mode) {
	const id = mode.get('id');
	if (id) (globalThis.__bodyBudgetRequests ??= new Map()).set(id, { answered: true });
}

export async function authenticate({ request, url }) {
	const mode = query(url);
	if (mode.has('hasbody')) return new Response(String(request.body !== null));
	// Answers that leave the body unread, one per way the lane can answer.
	if (mode.has('deny')) return false;
	if (mode.has('implicit')) { answered(mode); return undefined; }
	if (mode.has('nocontent')) { answered(mode); return new Response(null, { status: 204 }); }
	if (mode.has('redirect')) return new Response(null, { status: 303, headers: { location: '/' } });
	if (mode.has('respond')) return new Response('ok');
	if (mode.has('conn')) return new Response('ok', { headers: { connection: 'keep-alive' } });
	if (mode.has('throw')) throw new Error('authentication failed');
	return new Response(String((await request.arrayBuffer()).byteLength));
}

export async function admin(request) {
	const mode = query(request.url);
	if (mode.has('hasbody')) return new Response(String(request.body !== null));
	if (mode.has('signal')) {
		await new Promise(resolve => setTimeout(resolve, 500));
		globalThis.__adminSignalAborted = request.signal.aborted;
		return new Response('done');
	}
	if (mode.has('respond')) return new Response('ok');
	if (mode.has('nocontent')) { answered(mode); return new Response(null, { status: 204 }); }
	if (mode.has('redirect')) return new Response(null, { status: 303, headers: { location: '/' } });
	if (mode.has('conn')) return new Response('ok', { headers: { connection: 'keep-alive' } });
	if (mode.has('bad')) return 'not a response';
	if (mode.has('badbody')) return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('body failed')); } }));
	if (mode.has('throw')) throw new Error('admin failed');
	return new Response(String((await request.arrayBuffer()).byteLength));
}

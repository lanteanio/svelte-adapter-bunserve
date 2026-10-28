let armed = false;

function arm() {
	if (armed) return;
	armed = true;
	process.once('sveltekit:shutdown', async (reason, context) => {
		const hook = globalThis.__shutdownHookContext;
		console.log('[shutdown-probe] cleanup ' + JSON.stringify({
			reason, contextReason: context.reason,
			sameSignal: context.signal === hook.signal,
			sameDeadline: context.deadline === hook.deadline,
			aborted: context.signal?.aborted ?? false
		}));
		context.signal?.addEventListener('abort', () => console.log('[shutdown-probe] cleanup budget aborted'), { once: true });
		await new Promise(resolve => setTimeout(resolve, process.env.FIXTURE_SHUTDOWN_DRIVER === 'shared' ? 600 : 80));
		console.log('[shutdown-probe] cleanup done');
	});
}

export async function GET({ request, url }) {
	if (!process.env.FIXTURE_SHUTDOWN_DRIVER) return new Response('Not found', { status: 404 });
	arm();
	if (url.searchParams.has('hold')) {
		console.log('[shutdown-probe] request held');
		await new Promise(resolve => request.signal.addEventListener('abort', () => {
			console.log('[shutdown-probe] request aborted ' + JSON.stringify({ name: request.signal.reason.name, message: request.signal.reason.message }));
			resolve();
		}, { once: true }));
	}
	return new Response('armed');
}

export function POST() {
	if (!process.env.FIXTURE_SHUTDOWN_DRIVER) return new Response('Not found', { status: 404 });
	arm();
	// Dispatch the registered handler after this response has left SSR.
	setTimeout(() => process.emit('SIGTERM'), 20);
	return new Response('scheduled');
}

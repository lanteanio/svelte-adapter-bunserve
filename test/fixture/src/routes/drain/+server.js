import { json } from '@sveltejs/kit';

// Exercises the managed WebSocket drain without needing a real SIGTERM, which
// Windows cannot deliver. The signal path itself stays unverified here; this
// covers the part that does the work.
export function POST({ platform, url }) {
	const windowMs = Number(url.searchParams.get('windowMs') || '50');
	const close = url.searchParams.get('close') !== 'false';
	// `async: 1` drives the fail-closed path for a filter that returns a
	// Promise, which must advise NOBODY rather than draining the whole node.
	const filter = url.searchParams.get('async') === '1' ? async () => true : undefined;
	const advised = platform.adviseReconnect({ windowMs, close, filter });
	return json({ advised });
}

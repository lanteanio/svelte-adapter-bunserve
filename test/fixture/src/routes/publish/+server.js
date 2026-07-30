import { json } from '@sveltejs/kit';

// Proves the SSR request path carries the realtime platform: a load function or
// form action can publish to connected WebSocket clients without holding a
// socket itself.
export function POST({ platform, url }) {
	const topic = url.searchParams.get('topic') || 'room';
	const delivered = platform.publish(topic, 'from-http', { via: 'ssr' });
	return json({ delivered, requestId: platform.requestId, connections: platform.connections });
}

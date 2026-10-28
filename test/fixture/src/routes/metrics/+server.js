import { metrics } from '../../metrics.js';

// A configured registry is shared with application imports by the Vite plugin.
export async function GET({ platform, url }) {
	const snapshot = await platform.metricsSnapshot();
	if (snapshot === null) return new Response('metrics not configured', { status: 503 });
	const body = url.searchParams.has('registry') ? metrics.serialize() : snapshot;
	return new Response(body, {
		headers: {
			'content-type': 'text/plain; version=0.0.4; charset=utf-8',
			'x-fixture-metrics-shared': String(platform.metrics === metrics)
		}
	});
}

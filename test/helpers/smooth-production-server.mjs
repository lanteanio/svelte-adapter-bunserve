import { __setHooks } from './ws-handler-stub.mjs';

/** Run the source production handlers over a real native listener. */
export async function createProductionTestServer({ handler }) {
	globalThis.ENV_PREFIX = '';
	globalThis.WS_PATH = '/ws';
	globalThis.WS_OPTIONS = null;
	__setHooks(handler);
	const { websocketHandlers } = await import('../../src/runtime/handler/ws.js');
	const { setServer } = await import('../../src/runtime/handler/ws-state.js');
	const { upgradeData } = await import('./upgrade-data.mjs');
	const server = Bun.serve({
		hostname: '127.0.0.1', port: 0,
		fetch(request, native) {
			if (native.upgrade(request, { data: upgradeData() })) return;
			return new Response('upgrade required', { status: 400 });
		},
		websocket: websocketHandlers
	});
	setServer(server);
	return {
		wsUrl: `ws://127.0.0.1:${server.port}/ws`,
		async close() { server.stop(true); __setHooks({}); }
	};
}

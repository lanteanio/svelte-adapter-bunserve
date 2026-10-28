import { deliverWebhook } from '../../src/plugins/webhooks/server.js';

const result = await deliverWebhook({
	url: process.argv[2],
	urlMode: 'off',
	resolve: async () => ['127.0.0.1'],
	timeoutMs: 3000,
	retry: { attempts: 1 }
}, 'room', 'changed', { value: 1 });
console.log(JSON.stringify({ ok: result.ok, error: result.err?.message, code: result.err?.code }));

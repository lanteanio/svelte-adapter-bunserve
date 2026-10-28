import adapter, { type Platform, type WebSocket, type WebSocketHandler } from 'svelte-adapter-bunserve';
import { attribution, connectionSessionId } from 'svelte-adapter-bunserve/connection';
import { upgradeResponse } from 'svelte-adapter-bunserve/upgrade-response';
import { releaseSubscription } from 'svelte-adapter-bunserve/subscriptions';

adapter({ websocket: true });
adapter({ websocket: { handler: 'src/hooks.ws.ts', egress: { topic: { messages: 10 } } } });
const hooks: WebSocketHandler<{ id: string }> = {
	authenticate({ request, cookies, url, remoteAddress, getClientAddress, platform }) {
		cookies.set('session', remoteAddress, { path: '/', httpOnly: true });
		return new Response(JSON.stringify({ url, address: getClientAddress(), count: platform.connections, method: request.method }));
	},
	upgrade({ cookies, headers, url, remoteAddress, requestId, traceContext }) {
		const traceparent: string | undefined = traceContext?.traceparent;
		const tracestate: string | undefined = traceContext?.tracestate;
		return upgradeResponse({ id: cookies.session || requestId }, { 'x-region': headers.region || url || remoteAddress });
	},
	attribution(user) { return { principalId: user.id }; },
	open(ws) {
		const id: string = ws.getUserData().id;
		const session: string | undefined = connectionSessionId(ws);
		const tenant: string | undefined = attribution(ws)?.tenantId;
	},
	async subscribe(ws, topic, { platform }) { return 'FORBIDDEN'; },
	resume(ws, { lastSeenSeqs, lastSeenEpochs, sessionId, platform }) { return lastSeenSeqs; },
	shutdown({ platform, reason, signal, deadline }) { signal?.throwIfAborted(); },
	close(ws, { messagesIn, messagesOut, bytesIn, bytesOut, subscriptions }) {
		const counters: Array<number | undefined> = [messagesIn, messagesOut, bytesIn, bytesOut];
	}
};
declare const platform: Platform;
declare const ws: WebSocket<unknown>;
const published: boolean = ws.publish('room', 'hello');
// @ts-expect-error socket publish reports a boolean, unlike send's numeric status
const publishStatus: number = ws.publish('room', 'hello');
const released: boolean = releaseSubscription(ws, 'room');
// @ts-expect-error rollback requires a topic string
releaseSubscription(ws, 1);
const verdict: Promise<string | null> = platform.subscribe(ws, 'room');
const grant: Promise<string | null> = platform.checkSubscribe(ws, 'room', { requireGrant: true });
platform.publishWireBatch('room', 'state', [{ data: {}, seq: 1n }], { capability: 'binary', schemaVersion: 1, encode: () => null });
platform.send(ws, 'room', 'state', {}, { seq: 1n });
// @ts-expect-error subscriptions resolve asynchronously to a verdict
const joined: boolean = platform.subscribe(ws, 'room');
// @ts-expect-error subscribe has no third argument
platform.subscribe(ws, 'room', { allowSystemTopic: true });
// @ts-expect-error request is not implemented
platform.request(ws, 'state');
// @ts-expect-error sequence metadata is numeric or disabled
platform.send(ws, 'room', 'state', {}, { seq: '1' });
// @ts-expect-error tracing is not implemented
adapter({ tracing: './trace.js' });

type AdapterPlatform = Platform;
declare global {
	namespace App {
		interface Platform extends AdapterPlatform {}
	}
}
declare const appPlatform: App.Platform;
const appSubscription: Promise<string | null> = appPlatform.subscribe(ws, 'room');

// @ts-expect-error WebSocket requires its user-data type.
type SocketWithoutUserData = WebSocket;

import { createTestServer } from 'svelte-adapter-bunserve/testing';
import { LEAK_LANE_THRESHOLDS, judgeLeakLane, judgeLeakLaneSelfCheck, type LeakLaneMeasurements, type LeakLaneOptions, type LeakLaneVerdict } from 'svelte-adapter-bunserve/sim';
const localServer = createTestServer({ host: '127.0.0.1' });
// @ts-expect-error bind addresses must be strings
createTestServer({ host: 123 });
const measurements: LeakLaneMeasurements = { rss: [], errors: 0, requests: 1, baselineP95: 1, windowP95: 1, settled: true };
const leakOptions: LeakLaneOptions = { maxErrorRate: LEAK_LANE_THRESHOLDS.maxErrorRate };
const leakVerdict: LeakLaneVerdict = judgeLeakLane(measurements, leakOptions);
const leakDetected: boolean = judgeLeakLaneSelfCheck(leakVerdict).pass;
// @ts-expect-error exported thresholds are immutable
LEAK_LANE_THRESHOLDS.maxErrorRate = 1;

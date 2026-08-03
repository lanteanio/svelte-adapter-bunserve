// WebSocket fan-out benchmark client: N subscribers, a few senders bursting,
// measured delivered msg/s. The workload, burst shape and reporting mirror
// the sibling adapter's bench client so the two servers' numbers are
// comparable; this one uses the platform WebSocket (Bun's or Node's own),
// so it runs dependency-free under either runtime.
//
// Usage: bun bench/ws-fanout-client.mjs [clients] [duration_s]
//        (against whichever fan-out server is on PORT - the bunserve one or
//        the sibling's bench/24-ws-adapter-uws.mjs)

const NUM_CLIENTS = parseInt(process.argv[2] || '50');
const DURATION = parseInt(process.argv[3] || '8') * 1000;
const PORT = parseInt(process.env.PORT || '9002');
const NUM_SENDERS = Math.min(10, NUM_CLIENTS);
const PAYLOAD = JSON.stringify({ topic: 'bench', event: 'update', data: { id: 1, value: 'hello world benchmark payload' } });
const SUBSCRIBE_MSG = JSON.stringify({ type: 'subscribe', topic: 'bench' });

// Burst: send multiple messages per timer tick to push throughput.
const MSGS_PER_TICK = 50;
const TICK_MS = 1;

let totalSent = 0;
let totalReceived = 0;

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(new Error('connect failed: ' + (e?.message || e)));
	});
}

async function run() {
	console.log(`\n  Clients: ${NUM_CLIENTS} | Senders: ${NUM_SENDERS} | Duration: ${DURATION / 1000}s | Burst: ${MSGS_PER_TICK} msg/tick\n`);

	const t0 = performance.now();
	const clients = [];
	for (let i = 0; i < NUM_CLIENTS; i++) clients.push(await connect());
	console.log(`  Connected ${NUM_CLIENTS} clients in ${(performance.now() - t0).toFixed(0)}ms`);

	for (const ws of clients) {
		ws.onmessage = () => { totalReceived++; };
		ws.send(SUBSCRIBE_MSG);
	}
	await new Promise((r) => setTimeout(r, 100));
	console.log(`  Subscribed ${NUM_CLIENTS} clients to 'bench' topic`);

	const senders = clients.slice(0, NUM_SENDERS);
	const intervals = [];
	const startTime = performance.now();
	for (const sender of senders) {
		intervals.push(setInterval(() => {
			for (let i = 0; i < MSGS_PER_TICK; i++) {
				// Count only what actually went out: a dropped sender must
				// deflate the send rate, not fake a worse fan-out ratio.
				if (sender.readyState === 1) {
					sender.send(PAYLOAD);
					totalSent++;
				}
			}
		}, TICK_MS));
	}

	await new Promise((r) => setTimeout(r, DURATION));
	for (const iv of intervals) clearInterval(iv);
	const elapsed = performance.now() - startTime;

	await new Promise((r) => setTimeout(r, 500));
	for (const ws of clients) ws.close();

	const sendRate = totalSent / (elapsed / 1000);
	const recvRate = totalReceived / (elapsed / 1000);
	const fanout = totalSent > 0 ? (totalReceived / totalSent).toFixed(1) : '0.0';
	console.log(`  Messages sent:     ${totalSent.toLocaleString()} (${Math.round(sendRate).toLocaleString()}/s)`);
	console.log(`  Messages received: ${totalReceived.toLocaleString()} (${Math.round(recvRate).toLocaleString()}/s)`);
	console.log(`  Fan-out ratio:     ${fanout}x (expected ~${NUM_CLIENTS}x)`);
	console.log(`  Effective throughput: ${Math.round(recvRate).toLocaleString()} msg/s delivered\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });

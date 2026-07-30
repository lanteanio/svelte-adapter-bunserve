// Minimal dependency-free HTTP benchmark: N keep-alive connections each
// issuing sequential requests for a fixed duration, reporting throughput and
// latency percentiles. The same Node client drives every server under test,
// so cross-adapter numbers share their client-side overhead.
//
// usage: node bench/http-bench.mjs <url> [connections] [seconds] [warmupSeconds]
//
// The first warmupSeconds (default 1) of traffic is driven but NOT recorded,
// so connection ramp-up and server JIT warmup stay out of the percentiles.

import http from 'node:http';

const target = process.argv[2];
if (!target) {
	console.error('usage: node bench/http-bench.mjs <url> [connections] [seconds] [warmupSeconds]');
	process.exit(1);
}
const url = new URL(target);
const connections = parseInt(process.argv[3] || '32', 10);
const seconds = parseFloat(process.argv[4] || '10');
const warmupSeconds = parseFloat(process.argv[5] || '1');

const agent = new http.Agent({ keepAlive: true, maxSockets: connections });

const latencies = [];
let completed = 0;
let errors = 0;
let bytes = 0;
let running = true;
let recording = false;

function once() {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		const req = http.request(
			{
				agent,
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method: 'GET'
			},
			(res) => {
				res.on('data', (chunk) => { if (recording) bytes += chunk.length; });
				res.on('end', () => {
					if (recording) {
						latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
						completed++;
					}
					resolve();
				});
			}
		);
		req.on('error', () => { if (recording) errors++; resolve(); });
		req.end();
	});
}

async function worker() {
	while (running) {
		await once();
	}
}

const workers = Array.from({ length: connections }, () => worker());
await new Promise((r) => setTimeout(r, warmupSeconds * 1000));
recording = true;
const started = process.hrtime.bigint();
await new Promise((r) => setTimeout(r, seconds * 1000));
running = false;
await Promise.all(workers);
const elapsed = Number(process.hrtime.bigint() - started) / 1e9;

latencies.sort((a, b) => a - b);
const pct = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : NaN;

console.log(JSON.stringify({
	url: target,
	connections,
	seconds: +elapsed.toFixed(2),
	completed,
	errors,
	rps: +(completed / elapsed).toFixed(1),
	mbps: +((bytes / elapsed) / (1024 * 1024)).toFixed(2),
	p50_ms: +pct(0.5).toFixed(2),
	p90_ms: +pct(0.9).toFixed(2),
	p99_ms: +pct(0.99).toFixed(2)
}));

// Measures the control-frame ack channel: how much egress one inbound frame
// buys, and where the per-connection budget cuts a sustained run off.
//
// It exists because the amplification numbers in the CHANGELOG and in the
// comments around sendControl were written from an estimate rather than a
// measurement, and three different figures for the same claim ended up in three
// files. Anything quoted about this lane should come from a run of this file.
//
// What it answers:
//   1. A full batch of ordinary topic names with a `ref`: the amplification a
//      real client sees. Per-entry acks are what the family client needs, so
//      this factor cannot be driven to 1 without breaking resume.
//   2. The WORST-shaped legal batch - shortest possible entries, longest ref
//      the adapter will echo. This is the number to quote a bound from; (1) is
//      the best case, and quoting the best case as the measurement is exactly
//      how the figures this file replaced were wrong.
//   3. The same batch with no `ref`: the channel is silent, which is what makes
//      the factor a property of asking for acks rather than of subscribing.
//   4. A batch one entry past the limit, and a maximal frame packed entirely
//      with entries past it: both must cost exactly ONE frame. That is the
//      whole point of refusing an oversized batch whole - the reply must not
//      scale with the inbound frame.
//   5. A sustained run of (2): how much a socket can extract before the budget
//      cuts it, and with which close code.
//
// Needs a built fixture: cd test/fixture && npm run build
// Run: bun bench/control-egress.mjs

import { fileURLToPath } from 'node:url';

const PORT = 8807;
// fileURLToPath, not `pathname`: on POSIX the pathname is already absolute and
// stripping its leading slash produces a RELATIVE path, so the spawned server
// silently never comes up.
const BUILD = fileURLToPath(new URL('../test/fixture/build/index.js', import.meta.url));
const CONTROL_FRAME_LIMIT = 8192;
const MAX_BATCH_TOPICS = 256;

/** @param {string[]} topics @param {number|string|null} ref */
function batchFrame(topics, ref) {
	return JSON.stringify(
		ref === null ? { type: 'subscribe-batch', topics } : { type: 'subscribe-batch', topics, ref }
	);
}

/**
 * The worst-shaped LEGAL batch: every entry as short as a topic can be, so the
 * per-frame overhead dominates, and the longest ref the adapter will echo, so
 * every answer carries it. This is the shape to quote a worst case from - a
 * batch of ordinary topic names is the best case, and quoting that as the
 * measurement is how the earlier numbers here were wrong.
 */
function adversarialBatch() {
	const ref = 'r'.repeat(128);
	const topics = Array.from({ length: MAX_BATCH_TOPICS }, (_, i) => String(i % 10));
	return { frame: batchFrame(topics, ref), entries: topics.length };
}

const proc = Bun.spawn(['bun', BUILD], {
	env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
	stdout: 'pipe',
	stderr: 'pipe'
});

async function waitForServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return true;
		} catch {}
		await Bun.sleep(100);
	}
	return false;
}

/** Open a socket that tallies every byte in each direction. */
async function openCounted() {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	const tally = { in: 0, out: 0, frames: 0, closeCode: null };
	ws.onmessage = (e) => {
		tally.out += Buffer.byteLength(e.data);
		tally.frames++;
	};
	ws.onclose = (e) => {
		tally.closeCode = e.code;
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	// The welcome frame is not part of what the client's own traffic bought.
	await Bun.sleep(100);
	tally.out = 0;
	tally.frames = 0;
	return {
		ws,
		tally,
		send(frame) {
			tally.in += Buffer.byteLength(frame);
			ws.send(frame);
		}
	};
}

/** Wait until no further frame has arrived for `quietMs`. */
async function settle(tally, quietMs = 400, capMs = 15_000) {
	const started = performance.now();
	while (performance.now() - started < capMs) {
		const before = tally.frames;
		await Bun.sleep(quietMs);
		if (tally.frames === before) return;
	}
}

try {
	if (!(await waitForServer())) throw new Error('server never came up');

	// --- a full but ordinary batch, acks requested -------------------------
	const ordinary = batchFrame(
		Array.from({ length: MAX_BATCH_TOPICS }, (_, i) => `room:${i}`),
		1
	);
	const acked = await openCounted();
	acked.send(ordinary);
	await settle(acked.tally);
	console.log('a full batch of ordinary topic names, ref present');
	console.log(`  entries          ${MAX_BATCH_TOPICS}`);
	console.log(`  bytes in         ${acked.tally.in}`);
	console.log(`  bytes out        ${acked.tally.out} in ${acked.tally.frames} frames`);
	console.log(`  amplification    ${(acked.tally.out / acked.tally.in).toFixed(1)}x`);
	acked.ws.close();

	// --- the worst-shaped legal frame --------------------------------------
	const worst = adversarialBatch();
	const hostile = await openCounted();
	hostile.send(worst.frame);
	await settle(hostile.tally);
	console.log('worst-shaped legal batch (256 one-char entries, 128-byte ref)');
	console.log(`  bytes in         ${hostile.tally.in}`);
	console.log(`  bytes out        ${hostile.tally.out} in ${hostile.tally.frames} frames`);
	console.log(`  amplification    ${(hostile.tally.out / hostile.tally.in).toFixed(1)}x`);
	hostile.ws.close();

	// --- one entry past the limit, refused whole ---------------------------
	const over = batchFrame(
		Array.from({ length: MAX_BATCH_TOPICS + 1 }, (_, i) => 'o' + i),
		9
	);
	const overflow = await openCounted();
	overflow.send(over);
	await settle(overflow.tally);
	console.log('one entry past the limit');
	console.log(`  bytes in         ${overflow.tally.in}`);
	console.log(`  bytes out        ${overflow.tally.out} in ${overflow.tally.frames} frames`);
	overflow.ws.close();

	// --- a frame packed with entries, all past the limit -------------------
	// The shape the per-entry overflow answer turned into an 800KB reply. It
	// must now cost exactly one frame no matter how many entries arrive.
	const packed = [];
	while (Buffer.byteLength(batchFrame(packed, 10)) < CONTROL_FRAME_LIMIT - 8) packed.push('0');
	const flood = await openCounted();
	flood.send(batchFrame(packed, 10));
	await settle(flood.tally);
	console.log(`a maximal frame of ${packed.length} entries, all past the limit`);
	console.log(`  bytes in         ${flood.tally.in}`);
	console.log(`  bytes out        ${flood.tally.out} in ${flood.tally.frames} frames`);
	flood.ws.close();

	// --- the same frame with no ref ----------------------------------------
	const silent = await openCounted();
	silent.send(batchFrame(Array.from({ length: MAX_BATCH_TOPICS }, (_, i) => `quiet:${i}`), null));
	await settle(silent.tally);
	console.log('a full batch of ordinary topic names, no ref');
	console.log(`  bytes in         ${silent.tally.in}`);
	console.log(`  bytes out        ${silent.tally.out} in ${silent.tally.frames} frames`);
	silent.ws.close();

	// --- sustained, until the budget cuts it -------------------------------
	// The worst-shaped LEGAL frame, because that is what can still drive the
	// channel: an oversized batch now costs one frame however it is packed, so
	// sending those would measure the refusal, not the budget.
	const sustained = await openCounted();
	const startedAt = performance.now();
	let sent = 0;
	for (let i = 0; i < 4000 && sustained.tally.closeCode === null; i++) {
		sustained.send(adversarialBatch().frame);
		sent++;
		// Yield so the reader can keep up; without it the send loop starves the
		// event loop and nothing is counted until the end.
		if (i % 8 === 7) await Bun.sleep(1);
	}
	await settle(sustained.tally);
	const elapsed = (performance.now() - startedAt) / 1000;
	console.log('sustained until the budget cuts the connection');
	console.log(`  frames sent      ${sent}`);
	console.log(`  bytes in         ${(sustained.tally.in / 1024 / 1024).toFixed(2)} MB`);
	console.log(`  bytes out        ${(sustained.tally.out / 1024 / 1024).toFixed(2)} MB`);
	// Harness-paced, NOT a server throughput figure: the send loop yields every
	// eight frames so the reader can keep up. Quote the cut, not this.
	console.log(`  egress rate      ${(sustained.tally.out / 1024 / 1024 / elapsed).toFixed(1)} MB/s (harness-paced)`);
	console.log(`  close code       ${sustained.tally.closeCode}`);
	sustained.ws.close();
} finally {
	proc.kill();
}

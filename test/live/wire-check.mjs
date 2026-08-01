// The binary wire tier, end to end against the built fixture: capability
// negotiation, the wire-id announce, per-connection stateful encoding, the
// same seq on the binary frame and the JSON envelope, the batch member's
// per-entry fallback, the shared cohort split, and the resume paths. Raw
// WebSocket clients assert the client-delivered value - the frames the family
// client keys on - not a simulated harness.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';
import { parseBinaryFrame } from '../../src/runtime/utils/wire.js';
import { SHARED_WIRE_ID_BASE } from '../../src/runtime/utils/shared-wire-id.js';

const PORT = 8807;
const BUILD = buildPath();

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

await assertPortFree(PORT);

const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

/** A client collecting parsed text frames and raw binary frames separately. */
function client(name) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?user=${name}`);
	ws.binaryType = 'arraybuffer';
	const texts = [];
	const frames = [];
	ws.onmessage = (e) => {
		if (typeof e.data === 'string') {
			try { texts.push(JSON.parse(e.data)); } catch { /* not JSON, not under test */ }
		} else {
			frames.push(new Uint8Array(e.data));
		}
	};
	const opened = new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`client ${name} failed to connect`));
	});
	return { ws, texts, frames, opened, send: (obj) => ws.send(JSON.stringify(obj)) };
}

/** Wait (bounded) until the predicate holds. */
async function until(fn, what) {
	for (let i = 0; i < 100; i++) {
		if (fn()) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const readFloats = (payload) => {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	return { n: payload[0], x: view.getFloat32(1, false), y: view.getFloat32(5, false) };
};

try {
	await waitForServer(proc, PORT);

	const a = client('capable');
	const b = client('jsononly');
	await a.opened;
	await b.opened;
	a.send({ type: 'hello', caps: ['fixture.xy:1', 'fixture.snap:1'] });
	a.send({ type: 'subscribe', topic: 'wire:room', ref: 1 });
	b.send({ type: 'subscribe', topic: 'wire:room', ref: 1 });
	await until(
		() => a.texts.some((t) => t.type === 'subscribed') && b.texts.some((t) => t.type === 'subscribed'),
		'both subscriptions'
	);

	// --- per-connection stateful wire ---------------------------------------
	a.send({ type: 'fixture-wire', topic: 'wire:room', data: { x: 1.5, y: 2.5 } });
	await until(() => a.frames.length >= 1 && b.texts.some((t) => t.event === 'moved'), 'first wire publish');

	const announce = a.texts.find((t) => t.type === 'wire-id');
	check('the capable client is announced the topic id before the first frame',
		Boolean(announce) && announce.topic === 'wire:room' && typeof announce.id === 'number',
		JSON.stringify(announce));
	const f1 = parseBinaryFrame(a.frames[0]);
	check('the frame is a parseable 0x03 with the announced id', Boolean(f1) && f1.topicId === announce?.id, JSON.stringify(a.frames[0]?.slice(0, 8)));
	check('the codec payload round-trips (stateful counter + floats)',
		Boolean(f1) && readFloats(f1.payload).n === 1 && readFloats(f1.payload).x === 1.5 && readFloats(f1.payload).y === 2.5,
		f1 ? JSON.stringify(readFloats(f1.payload)) : 'no frame');
	const env1 = b.texts.find((t) => t.event === 'moved');
	check('the caps-less client gets the JSON envelope with the SAME seq',
		Boolean(env1) && env1.seq === f1?.seq && env1.data?.x === 1.5,
		JSON.stringify({ env: env1?.seq, frame: f1?.seq }));
	check('the capable client got no JSON duplicate of the frame',
		!a.texts.some((t) => t.event === 'moved'),
		JSON.stringify(a.texts.filter((t) => t.event === 'moved')));

	// --- no re-announce, state advances, seq advances -----------------------
	a.send({ type: 'fixture-wire', topic: 'wire:room', data: { x: 3, y: 4 } });
	await until(() => a.frames.length >= 2, 'second wire frame');
	const f2 = parseBinaryFrame(a.frames[1]);
	check('the second frame reuses the id with no second announce',
		f2?.topicId === announce?.id && a.texts.filter((t) => t.type === 'wire-id').length === 1,
		JSON.stringify({ id: f2?.topicId, announces: a.texts.filter((t) => t.type === 'wire-id').length }));
	check('the connection state advanced and the seq advanced',
		readFloats(f2.payload).n === 2 && f2.seq === f1.seq + 1,
		JSON.stringify({ n: readFloats(f2.payload).n, seq: f2.seq }));

	// --- sendWire: single target, seq 0 -------------------------------------
	a.send({ type: 'fixture-sendwire', topic: 'wire:room', data: { x: 9, y: 9 } });
	await until(() => a.frames.length >= 3, 'sendWire frame');
	const f3 = parseBinaryFrame(a.frames[2]);
	check('sendWire delivers a binary frame with seq 0 and the shared codec state',
		f3?.seq === 0 && readFloats(f3.payload).n === 3,
		JSON.stringify({ seq: f3?.seq, n: f3 ? readFloats(f3.payload).n : null }));
	check('sendWire reached only its target', !b.texts.some((t) => t.event === 'snapshot'), '');

	// --- batch: declined batch form falls back per entry --------------------
	a.send({ type: 'fixture-wire-batch', topic: 'wire:room', entries: [{ data: { x: 1, y: 2 } }, { data: { x: 3, y: 4 } }] });
	await until(() => a.frames.length >= 5 && b.texts.filter((t) => t.event === 'moved').length >= 4, 'batch delivery');
	const f4 = parseBinaryFrame(a.frames[3]);
	const f5 = parseBinaryFrame(a.frames[4]);
	check('the declined batch arrives as per-entry binary frames with per-entry seqs',
		f4?.seq === f2.seq + 1 && f5?.seq === f2.seq + 2,
		JSON.stringify({ f4: f4?.seq, f5: f5?.seq }));
	// The two single publishes above already delivered envelopes; the batch's
	// are the two after them.
	const batchEnvs = b.texts.filter((t) => t.event === 'moved').slice(2);
	check('the caps-less client gets per-entry envelopes with matching seqs',
		batchEnvs.length === 2 && batchEnvs[0].seq === f4?.seq && batchEnvs[1].seq === f5?.seq,
		JSON.stringify(batchEnvs.map((e) => e.seq)));

	// --- shared cohort split ------------------------------------------------
	a.send({ type: 'subscribe', topic: 'wire:world', ref: 2 });
	b.send({ type: 'subscribe', topic: 'wire:world', ref: 2 });
	await until(
		() => a.texts.filter((t) => t.type === 'subscribed').length >= 2 && b.texts.filter((t) => t.type === 'subscribed').length >= 2,
		'world subscriptions'
	);
	a.send({ type: 'fixture-wire-shared', topic: 'wire:world', data: { t: 9 } });
	await until(() => a.frames.length >= 6 && b.texts.some((t) => t.event === 'tick'), 'shared publish');
	const sharedAnnounce = a.texts.find((t) => t.type === 'wire-id' && t.topic === 'wire:world');
	check('the shared topic announces a server-wide id past the partition base',
		Boolean(sharedAnnounce) && sharedAnnounce.id >= SHARED_WIRE_ID_BASE,
		JSON.stringify(sharedAnnounce));
	const f6 = parseBinaryFrame(a.frames[5]);
	const tickEnv = b.texts.find((t) => t.event === 'tick');
	check('the cohort frame carries the shared id and the envelope the same seq',
		f6?.topicId === sharedAnnounce?.id && tickEnv?.seq === f6?.seq,
		JSON.stringify({ frameId: f6?.topicId, frameSeq: f6?.seq, envSeq: tickEnv?.seq }));
	check('the shared payload is the byte-encoded data',
		f6 ? new TextDecoder().decode(f6.payload) === '{"t":9}' : false,
		f6 ? new TextDecoder().decode(f6.payload) : 'no frame');

	// --- recover-on-subscribe: replay, then live membership, then ack -------
	const c = client('resumer');
	await c.opened;
	c.send({ type: 'subscribe', topic: 'wire:room', ref: 3, recover: { offset: 0 } });
	await until(() => c.texts.some((t) => t.type === 'subscribed'), 'recover subscribe');
	const replayAt = c.texts.findIndex((t) => t.event === 'replayed');
	const ackAt = c.texts.findIndex((t) => t.type === 'subscribed');
	check('recover runs the resume hook and its replay precedes the subscribed ack',
		replayAt !== -1 && ackAt !== -1 && replayAt < ackAt,
		JSON.stringify({ replayAt, ackAt, types: c.texts.map((t) => t.type ?? t.event) }));

	// --- standalone resume frame --------------------------------------------
	c.send({ type: 'resume', sessionId: 'prev-session', lastSeenSeqs: { 'wire:room': 2 } });
	await until(() => c.texts.some((t) => t.type === 'resumed'), 'resume ack');
	const replay2At = c.texts.findIndex((t) => t.event === 'replayed' && t.data?.since === 2);
	const resumedAt = c.texts.findIndex((t) => t.type === 'resumed');
	check('the resume frame replays through the hook before the resumed ack',
		replay2At !== -1 && resumedAt !== -1 && replay2At < resumedAt,
		JSON.stringify({ replay2At, resumedAt }));
	check('the replay carries the presented session id',
		c.texts[replay2At]?.data?.sessionId === 'prev-session',
		JSON.stringify(c.texts[replay2At]));

	// --- the reported watermark, against an EXPLICIT seq mark ----------------
	// Everything above publishes with { seq: true }, the local counter, which
	// never marks a topic as explicitly stamped. A reported watermark is trusted
	// only up to what this server HAS stamped, so on those topics every report
	// is refused and the boundary is never reached; and because counter frames
	// are exempt from the dedup gate, the delivered bytes are identical whether
	// a report is honoured or thrown away. The lane is blind there by
	// construction. This drives the explicit lane instead, where the report is
	// accepted and the dedup floor is observable in what the client receives.
	const SEQ_TOPIC = 'wire:seqroom';
	const d = client('watermark');
	await d.opened;
	// The plan is armed BEFORE the resume window opens: on resume, the hook
	// publishes explicit seqs 21..23 from inside the window and reports 22 as
	// covered. 22 is a seq the server really stamped, so the report survives the
	// ceiling; 21 and 22 must then be deduped away and only 23 delivered.
	d.send({
		type: 'fixture-resume-plan',
		topic: SEQ_TOPIC,
		report: 22,
		publish: [21, 22, 23]
	});
	await until(() => d.texts.some((t) => t.event === 'resume-planned'), 'resume plan armed');
	// A pre-window explicit publish, so the topic carries a real mark before the
	// window opens rather than being marked only from inside it.
	d.send({ type: 'fixture-publish-seq', topic: SEQ_TOPIC, seq: 20, data: { pre: true } });
	await Bun.sleep(50);

	d.send({ type: 'subscribe', topic: SEQ_TOPIC, ref: 9, recover: { offset: 20 } });
	await until(() => d.texts.some((t) => t.type === 'subscribed'), 'watermark recover subscribe');
	const inWindow = d.texts.filter((t) => t.event === 'said' && t.data?.inWindow !== undefined);
	const seqs = inWindow.map((t) => t.data.inWindow);
	check('a watermark the server stamped is honoured: frames at or below it are deduped',
		!seqs.includes(21) && !seqs.includes(22),
		JSON.stringify(seqs));
	check('and the frame above the watermark is delivered',
		seqs.includes(23),
		JSON.stringify(seqs));
	const ackAt2 = d.texts.findIndex((t) => t.type === 'subscribed');
	const above = d.texts.findIndex((t) => t.data?.inWindow === 23);
	check('the surviving in-window frame arrives before the subscribed ack',
		above !== -1 && ackAt2 !== -1 && above < ackAt2,
		JSON.stringify({ above, ackAt2 }));

	a.ws.close();
	b.ws.close();
	c.ws.close();
	d.ws.close();
} catch (err) {
	failed++;
	failures.push('THREW: ' + (err?.message ?? String(err)));
	console.log('FAIL threw: ' + (err?.stack ?? err));
} finally {
	try { proc.kill('SIGKILL'); } catch { /* already gone */ }
	if (failed > 0) {
		console.log('\n--- server stdout ---\n' + (await new Response(proc.stdout).text()).slice(-2000));
		console.log('\n--- server stderr ---\n' + (await new Response(proc.stderr).text()).slice(-2000));
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('failures:\n  ' + failures.join('\n  '));
process.exit(failed === 0 ? 0 : 1);

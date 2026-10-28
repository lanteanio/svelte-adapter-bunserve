// The ./subscriptions entry against a real built server.
//
// The fixture imports the entry by package name, so the helpers it calls are a
// separate module instance from the runtime the build copied - the shape a
// plugin in another package has. The suite reads the subscription total off
// the metrics route and the frames off the socket: a tracked join must charge
// the total once and receive the topic's publishes, join a shared topic's
// binary cohort, and give all of it back on the tracked leave. A hand-written
// registry entry is the control: it receives publishes while the total never
// hears of it.

import { assertPortFree, buildPath, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8823;
const BUILD = buildPath('build');
const BASE = `http://127.0.0.1:${PORT}`;
const CAP = 'fixture.snap:1';

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** The instance's subscription total, from the metrics route. */
async function total() {
	const text = await (await fetch(`${BASE}/metrics`)).text();
	const line = text.split('\n').find((l) => l.startsWith('ws_subscriptions '));
	return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

/**
 * One connection, collecting text and binary frames, with an `op` that runs a
 * fixture membership operation and resolves once the server has answered it.
 */
function client() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		ws.binaryType = 'arraybuffer';
		/** @type {any[]} */
		const texts = [];
		/** @type {ArrayBuffer[]} */
		const binary = [];
		/** @type {Map<number, (ok: unknown) => void>} */
		const waiting = new Map();
		let nonce = 0;
		const timer = setTimeout(() => reject(new Error('no open')), 5_000);
		ws.onmessage = (ev) => {
			if (typeof ev.data !== 'string') { binary.push(ev.data); return; }
			const msg = JSON.parse(ev.data);
			texts.push(msg);
			if (msg.topic === '__fixture' && msg.event === 'membership') {
				waiting.get(msg.data.nonce)?.(msg.data.ok);
				waiting.delete(msg.data.nonce);
			}
		};
		ws.onopen = () => {
			clearTimeout(timer);
			resolve({
				ws,
				texts,
				binary,
				send: (/** @type {object} */ frame) => ws.send(JSON.stringify(frame)),
				/**
				 * Run one membership operation; the answer arrives after every
				 * frame the operation itself sent.
				 * @param {string} mode
				 * @param {string} topic
				 */
				op(mode, topic) {
					const n = ++nonce;
					const answered = new Promise((res, rej) => {
						waiting.set(n, res);
						setTimeout(() => rej(new Error(`no answer to ${mode} ${topic}`)), 5_000);
					});
					ws.send(JSON.stringify({ type: 'fixture-membership', mode, topic, nonce: n }));
					return answered;
				}
			});
		};
		ws.onerror = () => reject(new Error('socket error'));
	});
}

/** Frames published to `topic` that this client received. */
const said = (/** @type {any} */ c, /** @type {string} */ topic) =>
	c.texts.filter((/** @type {any} */ f) => f.topic === topic && f.event === 'said');

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT), ORIGIN: BASE }),
	stdout: 'pipe',
	stderr: 'pipe'
});

/** Everything the server wrote, for the no-diagnostic check at the end. */
let serverOutput = '';
const drain = async (/** @type {ReadableStream} */ stream) => {
	const decoder = new TextDecoder();
	for await (const chunk of stream) serverOutput += decoder.decode(chunk);
};
const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);

try {
	await waitForServer(proc, PORT);
	const baseline = await total();
	check('the metrics route reports a subscription total', typeof baseline === 'number', String(baseline));

	// - a tracked join, a publish, a tracked leave ----------------------------
	const a = await client();
	check('a tracked join answers true', (await a.op('tracked', 'members:a')) === true);
	check('and charges the subscription total once', (await total()) === baseline + 1, `${await total()} vs ${baseline}`);
	check('a repeat join is idempotent', (await a.op('tracked', 'members:a')) === true && (await total()) === baseline + 1);
	a.send({ type: 'fixture-publish', topic: 'members:a', data: { n: 1 } });
	await a.op('noop', 'members:a');
	check('the joined socket receives the topic\'s publish', said(a, 'members:a').length === 1, JSON.stringify(said(a, 'members:a')));
	check('a tracked leave answers true', (await a.op('tracked-leave', 'members:a')) === true);
	check('and gives the total back', (await total()) === baseline, `${await total()} vs ${baseline}`);
	a.send({ type: 'fixture-publish', topic: 'members:a', data: { n: 2 } });
	await a.op('noop', 'members:a');
	check('and the socket stops receiving the topic', said(a, 'members:a').length === 1, JSON.stringify(said(a, 'members:a')));

	// - a shared topic: the cohort through the platform slot -------------------
	const b = await client();
	b.send({ type: 'hello', caps: [CAP] });
	// The first shared publish, with a capable client connected and nobody on
	// the topic, marks it shared; the tracked join then has to enter the
	// binary cohort itself.
	b.send({ type: 'fixture-wire-shared', topic: 'board:s', data: { tick: 0 } });
	await b.op('noop', 'board:s');
	check('a tracked join of a shared topic answers true', (await b.op('tracked', 'board:s')) === true);
	const announces = b.texts.filter((/** @type {any} */ f) => f.type === 'wire-id' && f.topic === 'board:s');
	check('the join is announced the topic\'s shared id, once', announces.length === 1, JSON.stringify(announces));
	b.send({ type: 'fixture-wire-shared', topic: 'board:s', data: { tick: 1 } });
	await b.op('noop', 'board:s');
	check('and receives one binary frame per shared publish', b.binary.length === 1, String(b.binary.length));
	check('and never the envelope beside it',
		!b.texts.some((/** @type {any} */ f) => f.topic === 'board:s' && f.event === 'tick'));
	check('the tracked leave answers true', (await b.op('tracked-leave', 'board:s')) === true);
	b.send({ type: 'fixture-wire-shared', topic: 'board:s', data: { tick: 2 } });
	await b.op('noop', 'board:s');
	check('after the leave no shared frame arrives', b.binary.length === 1, String(b.binary.length));
	check('and the total is back where it started', (await total()) === baseline, `${await total()} vs ${baseline}`);

	// - the control: a registry entry written by hand ----------------------
	check('a hand-written registry entry is accepted', (await a.op('raw', 'members:r')) === true);
	a.send({ type: 'fixture-publish', topic: 'members:r', data: { n: 1 } });
	await a.op('noop', 'members:r');
	check('it receives the topic\'s publish', said(a, 'members:r').length === 1);
	check('but the subscription total never hears of it', (await total()) === baseline, `${await total()} vs ${baseline}`);
	// Taken out again before the close, which would otherwise release an entry
	// the total never counted and report it as an invariant violation.
	check('the hand-written entry is removed', (await a.op('raw-leave', 'members:r')) === true);

	// - closes leave the total where it started --------------------------------
	check('a tracked join held at close', (await a.op('tracked', 'members:c')) === true);
	a.ws.close();
	b.ws.close();
	let after;
	for (let i = 0; i < 50; i++) {
		after = await total();
		if (after === baseline) break;
		await Bun.sleep(50);
	}
	check('the close released the held join', after === baseline, `${after} vs ${baseline}`);
} catch (err) {
	failed++;
	failures.push(`threw: ${err && err.message}`);
	console.log(`FAIL  threw: ${err && err.stack}`);
} finally {
	proc.kill();
	await proc.exited;
	await drained;
}

check('the server logged no invariant violation or diagnostic line',
	!serverOutput.includes('lantean/diagnostic'),
	serverOutput.split('\n').filter((l) => l.includes('lantean/diagnostic')).join(' | '));

console.log(`\nsubscriptions-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}

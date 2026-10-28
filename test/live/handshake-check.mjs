// The handshake rule, against a real server over raw sockets: svelte-adapter-uws's
// own case set, sent line by line, so a repeated line arrives as two lines and
// meets Bun's joining of it, which is what the rule reads. Each answer has to
// be the one uws gives, a refused case has to open no socket, and each refusal
// has to be counted once as `malformed_handshake`.
//
// Runs against the fixture's MAIN build, whose route src/routes/metrics serves
// the count.

import { HANDSHAKE } from '../helpers/handshake.mjs';
import { assertPortFree, buildPath, rawExchange, serverEnv, waitForServer } from './harness.mjs';

const PORT = 8825;
const BUILD = buildPath('build');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
const check = (name, cond, detail) => {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
};

/** @type {Array<[string, string]>} */
const NORMAL = [
	['Connection', 'keep-alive, UpGrAdE'],
	['Upgrade', 'WebSocket'],
	['Sec-WebSocket-Version', '13'],
	['Sec-WebSocket-Key', HANDSHAKE['sec-websocket-key']]
];
const without = (name) => NORMAL.filter(([k]) => k !== name);
const replaced = (name, value) => NORMAL.map(([k, v]) => [k, k === name ? value : v]);
const repeated = (name) => [...NORMAL, NORMAL.find(([k]) => k === name)];

/** @type {Array<[string, Array<[string, string]>, number]>} */
const CASES = [
	['a complete handshake', NORMAL, 101],
	['no Upgrade', without('Upgrade'), 400],
	['no Connection', without('Connection'), 400],
	['no key', without('Sec-WebSocket-Key'), 400],
	['an Upgrade naming another protocol', replaced('Upgrade', 'not-websocket'), 400],
	['a Connection without upgrade', replaced('Connection', 'keep-alive'), 400],
	['a 24-character key that is not base64', replaced('Sec-WebSocket-Key', '!'.repeat(24)), 400],
	['a short key', replaced('Sec-WebSocket-Key', 'a'), 400],
	['a key with its unused bits set', replaced('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZR=='), 400],
	['Upgrade twice', repeated('Upgrade'), 400],
	['the key twice', repeated('Sec-WebSocket-Key'), 400],
	['the version twice', repeated('Sec-WebSocket-Version'), 400],
	// An empty line is still a line, and Bun keeps it in the join.
	['13 and an empty version line', [...NORMAL, ['Sec-WebSocket-Version', '']], 400],
	['an empty version line and 13', [['Sec-WebSocket-Version', ''], ...NORMAL], 400],
	['version 12', replaced('Sec-WebSocket-Version', '12'), 426],
	['version 8', replaced('Sec-WebSocket-Version', '8'), 426],
	['a version that is not a number', replaced('Sec-WebSocket-Version', '13a'), 426],
	['upgrade listed on a second Connection line', [...without('Connection'), ['Connection', 'keep-alive'], ['Connection', 'Upgrade']], 101],
	['no version', without('Sec-WebSocket-Version'), 426],
	['a websocket Upgrade with no key', [['Connection', 'Upgrade'], ['Upgrade', 'websocket']], 400]
];

/** The value of one rendered series, as a number. */
function series(text, prefix) {
	const line = text.split('\n').find((l) => l.startsWith(prefix + ' ') || l.startsWith(prefix + '{'));
	return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

const MALFORMED = 'upgrade_rejected_total{reason="malformed_handshake"}';
const malformed = async () => series(await (await fetch(`${BASE}/metrics`)).text(), MALFORMED);

await assertPortFree(PORT);
const proc = Bun.spawn([process.execPath, BUILD], {
	env: serverEnv({ HOST: '127.0.0.1', PORT: String(PORT) }),
	stdout: 'pipe',
	stderr: 'pipe'
});

try {
	await waitForServer(proc, PORT);

	const before = await malformed();
	check('the reason is published from the first scrape', before === 0, String(before));

	let refusals = 0;
	for (const [name, headers, expected] of CASES) {
		const { status, headers: got } = await rawExchange(PORT, headers);
		const versionOk = expected !== 426 || got['sec-websocket-version'] === '13';
		check(`answers ${expected} to ${name}`, status === expected && versionOk,
			`got ${status}${expected === 426 ? `, sec-websocket-version ${got['sec-websocket-version']}` : ''}`);
		if (expected !== 101) refusals++;
	}

	const after = await malformed();
	check('each refusal is counted once as malformed_handshake', after - before === refusals,
		`${before} -> ${after}, ${refusals} refused`);

	// A GET to the path that is not trying to open a WebSocket is not judged:
	// it is the app's, and it is not counted.
	const plain = await rawExchange(PORT, []);
	const h2c = await rawExchange(PORT, [['Connection', 'Upgrade'], ['Upgrade', 'h2c']]);
	check('a GET that is not a handshake still reaches the app', plain.status === 200 && plain.headers['x-app-route'] === 'ws',
		`got ${plain.status}`);
	check('and so does an upgrade to another protocol', h2c.status === 200 && h2c.headers['x-app-route'] === 'ws',
		`got ${h2c.status}`);
	check('and neither is counted', (await malformed()) === after, String(await malformed()));
} finally {
	proc.kill();
	await proc.exited;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
	console.log(failures.map((f) => '  - ' + f).join('\n'));
	process.exit(1);
}

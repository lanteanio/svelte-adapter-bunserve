import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { serverEnv } from './harness.mjs';

for (const [key, value] of Object.entries(serverEnv({}))) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
const { start } = await import('../fixture/build/server.js');
const { requestSignals, counters } = await import('../fixture/build/handler/state.js');
const { abortInFlightRequests, drain } = await import('../fixture/build/handler/lifecycle.js');
const server = start('127.0.0.1', 0);
const base = `http://127.0.0.1:${server.port}`;
const records = () => globalThis.__requestSignalRecords;
async function until(predicate, label = 'condition') {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		if (performance.now() >= deadline) throw Error(`request signal ${label} did not settle`);
		await new Promise(resolve => setImmediate(resolve));
	}
}
function raw(id, method = 'GET', length = 0, body = '', mode = 'hold') {
	const socket = connect(server.port, '127.0.0.1');
	socket.received = false;
	socket.sent = false;
	socket.on('data', () => { socket.received = true; });
	socket.on('error', () => {});
	socket.on('connect', () => socket.write(`${method} /request-signal?id=${id}&${mode}=1 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n${method === 'POST' ? `Content-Length: ${length}\r\nContent-Type: application/octet-stream\r\n` : ''}\r\n${body}`, () => { socket.sent = true; }));
	return socket;
}
try {
	const get = raw('get');
	await until(() => records()?.get('get')?.ready, 'get ready');
	get.destroy();
	await until(() => records().get('get').aborted, 'get abort');
	assert.equal(records().get('get').reason.name, 'AbortError');
	records().get('get').release();
	await until(() => requestSignals.size === 0, 'registry empty');

	console.log('GET disconnect passed');
	const complete = raw('complete', 'POST', 3, 'abc');
	await until(() => records().get('complete')?.ready);
	complete.destroy();
	await new Promise(resolve => complete.once('close', resolve));
	assert.equal(records().get('complete').aborted, false);
	records().get('complete').release();
	await until(() => requestSignals.size === 0);

	console.log('complete POST disconnect passed');
	// Fully sent does not mean observed complete: an unread body can leave its
	// native EOF queued behind the adapter's bounded read-ahead window.
	const unread = raw('unread', 'POST', 256 * 1024, 'x'.repeat(64 * 1024), 'hold=1&unread');
	await until(() => unread.sent && records().get('unread')?.ready, 'unread upload ready');
	// Fill the read-ahead queue before delivering the remaining native body.
	await new Promise(resolve => setTimeout(resolve, 50));
	await new Promise(resolve => unread.write('x'.repeat(192 * 1024), resolve));
	// Let local TCP delivery settle without introducing application demand.
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(records().get('unread').aborted, false);
	unread.destroy();
	await until(() => records().get('unread').aborted, 'unread upload disconnect');
	assert.equal(records().get('unread').reason.name, 'AbortError');
	records().get('unread').release();
	await until(() => requestSignals.size === 0, 'unread registry empty');
	console.log('unread large POST disconnect boundary passed');
	const partial = raw('partial', 'POST', 10, 'abc');
	await until(() => records().has('partial'));
	partial.destroy();
	await until(() => records().get('partial').bodyError);
	assert.equal(records().get('partial').signal.reason.name, 'AbortError');
	assert.equal(records().get('partial').bodyError.message, 'Request aborted');
	await until(() => requestSignals.size === 0);

	console.log('partial POST disconnect passed');
	const done = await fetch(`${base}/request-signal?id=done`);
	await done.text();
	await until(() => requestSignals.size === 0);
	assert.equal(records().get('done').aborted, false);

	const failed = await fetch(`${base}/request-signal?id=failed&error=1`, { headers: { cookie: 'private=1' } });
	await failed.text();
	await until(() => requestSignals.size === 0);
	assert.equal(failed.status, 500);
	assert.equal(records().get('failed').aborted, true);

	console.log('completed response passed');
	const streamed = await fetch(`${base}/request-signal?id=stream&stream=1`);
	let drained = false;
	const waiting = drain().then(() => { drained = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(drained, false);
	records().get('stream').output.close();
	await streamed.text();
	await waiting;
	assert.equal(counters.inFlightCount, 0);

	const lengthStream = await fetch(`${base}/request-signal?id=length&stream=1&length=1`);
	assert.equal(counters.inFlightCount, 1);
	records().get('length').output.close();
	await lengthStream.text();
	await until(() => counters.inFlightCount === 0, 'counter empty');

	const cancelledStream = raw('cancel', 'GET', 0, '', 'stream');
	await until(() => cancelledStream.received, 'stream response');
	cancelledStream.destroy();
	await until(() => records().get('cancel').aborted, 'stream abort');
	await until(() => records().get('cancel').cancelled, 'source cancellation');
	await until(() => counters.inFlightCount === 0, 'counter empty');

	const dedupUrl = `${base}/response-contract?mode=first-deferred&id=leader-abort`;
	const leaderAbort = new AbortController();
	const leader = fetch(dedupUrl, { signal: leaderAbort.signal }).catch(() => null);
	await until(() => globalThis.__responseContractRecords?.get('leader-abort')?.pulls === 1, 'leader first read');
	const leaderRecord = globalThis.__responseContractRecords.get('leader-abort');
	const survivor = fetch(dedupUrl, { signal: AbortSignal.timeout(5000) });
	survivor.catch(() => {});
	await until(() => counters.inFlightCount === 2, 'dedup waiter attached');
	leaderAbort.abort();
	await leader;
	await until(() => globalThis.__responseContractRecords.get('leader-abort') !== leaderRecord, 'survivor rerender');
	assert.equal(leaderRecord.cancels, 1);
	assert.equal(leaderRecord.body.locked, false);
	globalThis.__responseContractRecords.get('leader-abort').release();
	const survivorResponse = await survivor;
	assert.equal(survivorResponse.status, 200);
	assert.equal(await survivorResponse.text(), 'complete survivor');
	await until(() => counters.inFlightCount === 0, 'survivor complete');
	console.log('aborted dedup leader leaves its surviving waiter a complete response');

	const head = await fetch(`${base}/request-signal?id=head&stream=1`, { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), '');
	await until(() => counters.inFlightCount === 0, 'HEAD counter empty');
	assert.equal(records().get('head').aborted, false);
	assert.equal(records().get('head').cancelled, true);

	console.log('stream drain passed');
	const shutdown = raw('shutdown');
	await until(() => records().get('shutdown')?.ready);
	abortInFlightRequests();
	assert.equal(records().get('shutdown').reason.message, 'The server shut down before the request finished');
	assert.equal(records().get('shutdown').reason.name, 'AbortError');
	assert.equal(requestSignals.size, 0);
	records().get('shutdown').release();
	shutdown.destroy();
	await until(() => counters.inFlightCount === 0, 'counter empty');
	const abrupt = raw('abrupt', 'GET', 0, '', 'stream');
	await until(() => abrupt.received, 'shutdown stream response');
	abortInFlightRequests();
	assert.equal(records().get('abrupt').reason.name, 'AbortError');
	abrupt.destroy();
	server.stop(true);
	await until(() => counters.inFlightCount === 0, 'counter empty');
	console.log('request-signal: 13 live cases passed');
} finally {
	for (const record of records()?.values() ?? []) record.release?.();
	for (const record of globalThis.__responseContractRecords?.values() ?? []) record.release?.();
	server.stop(true);
}

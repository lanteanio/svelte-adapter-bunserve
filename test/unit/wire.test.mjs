import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	ByteReader,
	ByteWriter,
	WIRE_BINARY_TAG,
	allocWireId,
	buildBinaryFrame,
	createCapCounts,
	parseBinaryFrame,
	wireIdAnnounce
} from '../../src/runtime/utils/wire.js';
import {
	SHARED_WIRE_ID_BASE,
	createSharedWireIdTable
} from '../../src/runtime/utils/shared-wire-id.js';

const SLOT = Symbol('topicIds');

test('varint round-trips values across the 2^31 and 2^32 boundaries, with no upper bound', () => {
	// A long-lived per-topic seq exceeds 32 bits; bit-shift arithmetic would
	// silently wrap it. The shared wire-id space STARTS at 2^32. And the
	// explicit-seq lane deliberately has NO magnitude ceiling - snowflake ids
	// and log offsets live past 2^53 - so the biggest integer-valued doubles
	// are pinned too, not just the 32-bit boundaries.
	const values = [
		0, 1, 127, 128, 300, 0x7fffffff, 0x80000000, 0xffffffff,
		SHARED_WIRE_ID_BASE, 2 ** 43 + 12345,
		Number.MAX_SAFE_INTEGER, 2 ** 53, 1e308
	];
	for (const v of values) {
		const w = new ByteWriter();
		w.varint(v);
		const r = new ByteReader(w.take());
		assert.equal(r.varint(), v, `value ${v}`);
		assert.equal(r.done, true);
	}
});

test('varint refuses non-integers instead of spinning or writing garbage', () => {
	// Infinity would never exit the encode loop - the same
	// loop-that-cannot-exit class as the zero-capacity growth trap below -
	// NaN would write garbage bytes, and a negative or fractional value
	// parses back off the wire as a different number (-1 reads back as 127).
	// Every legitimate caller passes a validated seq, an internal id or a
	// real length, so anything else is refused at the primitive itself.
	for (const bad of [Infinity, -Infinity, NaN, -1, 1.5]) {
		const w = new ByteWriter();
		assert.throws(() => w.varint(bad), RangeError, `varint(${String(bad)})`);
		assert.equal(w.len, 0, `varint(${String(bad)}) wrote nothing`);
	}
});

test('f32, f64 and length-prefixed strings round-trip', () => {
	const w = new ByteWriter(4); // deliberately tiny: growth is under test too
	w.f32(1.5);
	w.f64(Math.PI);
	// Escapes, not literal umlauts: the repo's tracked files are byte-swept for
	// ASCII, and what this asserts is the multi-byte UTF-8 length prefix.
	const umlauts = 'mit Gr' + String.fromCharCode(0xfc, 0xdf) + 'en';
	w.str(umlauts);
	w.str('');
	const r = new ByteReader(w.take());
	assert.equal(r.f32(), 1.5);
	assert.equal(r.f64(), Math.PI);
	assert.equal(r.str(), umlauts);
	assert.equal(r.str(), '');
	assert.equal(r.done, true);
});

// HONEST LIMIT OF THIS TEST: the defect it pins is a synchronous infinite
// loop, and nothing in-process can bound one - node:test's timeout cannot
// interrupt a spinning event loop, so reintroducing the loop would wedge the
// run rather than fail it. What this asserts is that the capacity math is
// correct from a zero or NaN start; the defence against the hang is that
// `_ensure` no longer contains a loop that can fail to make progress.
test('a zero-capacity writer grows instead of spinning', () => {
	// Reachable from buildBinaryFrame, which sizes the writer `8 + payload.length`:
	// a payload with no numeric length makes that NaN, and ArrayBuffer floors NaN
	// to 0. Doubling from 0 stays at 0 forever. A growth primitive must not be one
	// bad caller away from an unbreakable loop, so this is pinned on the writer
	// itself rather than only on the caller that used to reach it.
	for (const initial of [0, NaN]) {
		const w = new ByteWriter(initial);
		w.u8(1);
		w.varint(300);
		w.f64(Math.PI);
		w.str('grown');
		const r = new ByteReader(w.take());
		assert.equal(r.u8(), 1, `initial=${String(initial)}`);
		assert.equal(r.varint(), 300);
		assert.equal(r.f64(), Math.PI);
		assert.equal(r.str(), 'grown');
		assert.equal(r.done, true);
	}
});

test('growth still reaches a capacity larger than one doubling', () => {
	// A write far bigger than twice the buffer has to be satisfied in one go.
	const w = new ByteWriter(4);
	const big = 'x'.repeat(5000);
	w.str(big);
	const r = new ByteReader(w.take());
	assert.equal(r.str(), big);
	assert.equal(r.done, true);
});

test('growth leaves slack, so a big write does not make the next write realloc', () => {
	// A PERFORMANCE invariant, pinned as a count rather than a timing because
	// timings here are pure noise. An exact-fit growth policy - max(double,
	// want) - satisfies the write but leaves capacity == len, so every
	// following write reallocates and copies the whole buffer: measured at
	// one extra realloc and up to twice the wall clock on a big-write
	// pattern. Doubling keeps the slack that makes growth amortised, and this
	// is the assertion that says so.
	const w = new ByteWriter(64);
	w.bytes(new Uint8Array(5000));
	const capacity = w._buf.length;
	assert.ok(capacity > w.len, `capacity ${capacity} must exceed len ${w.len}`);
	w.u8(1);
	assert.equal(w._buf.length, capacity, 'the following write reused the buffer');
});

test('reads past the end throw RangeError rather than returning garbage', () => {
	const r = new ByteReader(new Uint8Array([0x80]));
	assert.throws(() => r.varint(), RangeError);
	assert.throws(() => new ByteReader(new Uint8Array(2)).f32(), RangeError);
	assert.throws(() => new ByteReader(new Uint8Array(0)).u8(), RangeError);
});

test('binary frame header round-trips and the payload view is zero-copy', () => {
	const payload = new Uint8Array([9, 8, 7]);
	const frame = buildBinaryFrame(3, 42, SHARED_WIRE_ID_BASE + 1, payload);
	assert.equal(frame[0], WIRE_BINARY_TAG);
	const parsed = parseBinaryFrame(frame);
	assert.ok(parsed);
	assert.equal(parsed.schemaVersion, 3);
	assert.equal(parsed.topicId, 42);
	assert.equal(parsed.seq, SHARED_WIRE_ID_BASE + 1);
	assert.deepEqual([...parsed.payload], [9, 8, 7]);
	// Zero-copy: the payload views the frame's own buffer.
	assert.equal(parsed.payload.buffer, frame.buffer);
});

test('parseBinaryFrame returns null on foreign tags and truncated frames', () => {
	assert.equal(parseBinaryFrame(new Uint8Array([0x01, 1, 1, 0])), null);
	assert.equal(parseBinaryFrame(new Uint8Array([])), null);
	assert.equal(parseBinaryFrame(new Uint8Array([WIRE_BINARY_TAG])), null);
	// Header cut mid-varint: the id continues past the end of the frame.
	assert.equal(parseBinaryFrame(new Uint8Array([WIRE_BINARY_TAG, 1, 0x80])), null);
});

test('allocWireId is monotonic from 1 and stable per topic', () => {
	const ud = {};
	const a = allocWireId(ud, SLOT, 'alpha');
	const b = allocWireId(ud, SLOT, 'beta');
	const a2 = allocWireId(ud, SLOT, 'alpha');
	assert.deepEqual(a, { id: 1, isNew: true });
	assert.deepEqual(b, { id: 2, isNew: true });
	assert.deepEqual(a2, { id: 1, isNew: false });
	// A different connection starts its own space at 1.
	assert.deepEqual(allocWireId({}, SLOT, 'beta'), { id: 1, isNew: true });
});

test('wireIdAnnounce is the exact control-frame shape the client keys on', () => {
	assert.equal(wireIdAnnounce('room', 7), '{"type":"wire-id","topic":"room","id":7}');
	// Topic is JSON-escaped, so a quote in a topic cannot break the frame.
	assert.equal(JSON.parse(wireIdAnnounce('a"b', 2)).topic, 'a"b');
});

test('capCounts tracks live capability membership through hello re-sends and close', () => {
	const counts = createCapCounts();
	assert.equal(counts.has('cursor:3'), false);
	const first = new Set(['cursor:3', 'lease']);
	counts.adjust(null, first);
	assert.equal(counts.has('cursor:3'), true);
	// A re-sent hello REPLACES the set: dropped caps release their count.
	const second = new Set(['lease']);
	counts.adjust(first, second);
	assert.equal(counts.has('cursor:3'), false);
	assert.equal(counts.has('lease'), true);
	// Close releases whatever the connection last declared.
	counts.adjust(second, null);
	assert.equal(counts.has('lease'), false);
});

test('capCounts counts connections, not declarations', () => {
	const counts = createCapCounts();
	const a = new Set(['bin']);
	const b = new Set(['bin']);
	counts.adjust(null, a);
	counts.adjust(null, b);
	counts.adjust(a, null);
	assert.equal(counts.has('bin'), true, 'the second connection still holds it');
	counts.adjust(b, null);
	assert.equal(counts.has('bin'), false);
});

test('the shared wire-id table refcounts and never reuses a retired id', () => {
	const table = createSharedWireIdTable();
	const id = table.acquire('world');
	assert.ok(id >= SHARED_WIRE_ID_BASE);
	assert.equal(table.acquire('world'), id, 'second joiner shares the id');
	assert.equal(table.get('world'), id);
	table.release('world');
	assert.equal(table.get('world'), id, 'one ref remains');
	table.release('world');
	assert.equal(table.get('world'), undefined, 'last ref retires the entry');
	// A client can still hold the old announce, so the id must not re-point.
	const fresh = table.acquire('world');
	assert.notEqual(fresh, id);
	assert.ok(fresh > id);
	// Releasing an unknown topic is a no-op, not an error.
	table.release('never-acquired');
});

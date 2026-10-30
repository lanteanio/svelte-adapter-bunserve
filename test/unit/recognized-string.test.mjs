import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framePayload, nativeTopic, recognizedBytes, stringBytes } from '../../src/runtime/utils/recognized-string.js';

const unit = String.fromCharCode;
const HIGH = unit(0xd800);
const LOW = unit(0xdc00);
const MIXED = 'a' + unit(0xe9, 0x20ac, 0xd83d, 0xde00);
const ACCENTED = 'a' + unit(0xe9);

const bytes = value => [...(typeof value === 'string' ? Buffer.from(value) : value)];

test('every recognized string reads as exactly its own bytes', () => {
	const backing = new Uint8Array([0, 0x61, 0x62, 0x63, 0]);
	assert.deepEqual(bytes(recognizedBytes(backing.subarray(1, 4))), [0x61, 0x62, 0x63]);
	assert.deepEqual(bytes(recognizedBytes(new DataView(backing.buffer, 1, 3))), [0x61, 0x62, 0x63]);
	assert.deepEqual(bytes(recognizedBytes(new Uint16Array(backing.buffer, 0, 2))), [0, 0x61, 0x62, 0x63]);
	assert.deepEqual(bytes(recognizedBytes(backing.buffer)), [0, 0x61, 0x62, 0x63, 0]);
	const shared = new SharedArrayBuffer(2);
	new Uint8Array(shared).set([1, 2]);
	assert.deepEqual(bytes(recognizedBytes(shared)), [1, 2]);
	assert.deepEqual(bytes(recognizedBytes(new Uint8Array(shared, 1, 1))), [2]);
});

test('anything else is refused with the uWS message', () => {
	for (const value of [undefined, null, 1, true, {}, [1, 2], new Blob(['x'])]) {
		assert.throws(() => recognizedBytes(value), {
			name: 'Error',
			message: 'Text and data can only be passed by String, ArrayBuffer or ArrayBufferView.'
		});
	}
});

test('a string encodes as UTF-8 and an unpaired surrogate as its own three bytes', () => {
	assert.deepEqual(bytes(stringBytes(MIXED)), bytes(Buffer.from(MIXED)));
	assert.deepEqual(bytes(stringBytes(HIGH)), [0xed, 0xa0, 0x80]);
	assert.deepEqual(bytes(stringBytes(LOW + 'x')), [0xed, 0xb0, 0x80, 0x78]);
	assert.deepEqual(bytes(stringBytes(unit(0xd83d) + HIGH + LOW)), [0xed, 0xa0, 0xbd, 0xf0, 0x90, 0x80, 0x80]);
	assert.deepEqual(bytes(stringBytes('x' + HIGH)), [0x78, 0xed, 0xa0, 0x80]);
});

test('isBinary selects the frame kind Bun infers, keeping the bytes', () => {
	assert.equal(framePayload('x', false), 'x');
	assert.equal(framePayload('x', undefined), 'x');
	assert.equal(framePayload(HIGH, false), HIGH);
	assert.deepEqual(bytes(framePayload('x', true)), [0x78]);
	assert.ok(framePayload('x', true) instanceof Uint8Array);
	assert.deepEqual(bytes(framePayload(HIGH, true)), [0xed, 0xa0, 0x80]);
	assert.equal(framePayload(new Uint8Array([0x78]), false), 'x');
	assert.equal(framePayload(new Uint8Array([0xef, 0xbb, 0xbf, 0x78]), false), unit(0xfeff) + 'x');
	assert.equal(framePayload(new Uint8Array(0), false), '');
	const view = new Uint8Array([1, 2, 3]).subarray(1);
	assert.equal(framePayload(view, true), view);
	assert.deepEqual(bytes(framePayload(new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 1), true)), [8]);
});

test('bytes that are not UTF-8 are refused for a text frame', () => {
	for (const value of [new Uint8Array([0xff]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xc3])]) {
		assert.throws(() => framePayload(value, false), { name: 'TypeError', message: /valid UTF-8/ });
		assert.deepEqual(bytes(framePayload(value, true)), bytes(value));
	}
});

test('a string topic names itself and UTF-8 bytes name the topic they spell', () => {
	for (const topic of ['room', ACCENTED, MIXED, 'room\x00json', '\x00room', 'x\x00ab']) {
		assert.equal(nativeTopic(topic), topic);
		assert.equal(nativeTopic(Buffer.from(topic)), topic);
		assert.equal(nativeTopic(new TextEncoder().encode(topic).buffer), topic);
	}
	assert.equal(nativeTopic(HIGH), HIGH);
});

test('names Bun cannot take are escaped, and the escape never meets a caller spelling', () => {
	assert.equal(nativeTopic(''), '\x00');
	assert.equal(nativeTopic(new Uint8Array(0)), '\x00');
	assert.equal(nativeTopic(new Uint8Array([0xff])), '\x00ff');
	assert.equal(nativeTopic('\x00ff'), '\x00006666');
	assert.equal(nativeTopic(new Uint8Array([0, 0x66, 0x66])), nativeTopic('\x00ff'));
	assert.equal(nativeTopic('\x00'), '\x0000');
	assert.equal(nativeTopic(new Uint8Array([0])), nativeTopic('\x00'));
	const spellings = ['', '\x00', '\x00ff', '\x0000', '\x00006666', new Uint8Array([0xff]), new Uint8Array([0xff, 0xff]),
		new Uint8Array([0, 0]), 'ff', 'room'];
	const names = spellings.map(nativeTopic);
	assert.equal(new Set(names).size, spellings.length);
	assert.ok(names.every(name => name.length > 0));
});

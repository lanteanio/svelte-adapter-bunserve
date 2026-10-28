// Every adapter call that hands more than one frame to the delivery boundary
// opens one fan-out scope for the whole call, in the production runtime, so an
// operation a policy issues while deciding the first frame runs after the
// last. The audit itself is test/helpers/delivery-scope-audit.js; this file
// runs it over the sources and proves it rejects each shape it exists for.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditDeliveryScopes } from '../helpers/delivery-scope-audit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
	...readdirSync(path.join(ROOT, 'src/runtime/handler')).filter((name) => name.endsWith('.js')).map((name) => 'src/runtime/handler/' + name)
];
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const sources = () => FILES.map((file) => ({ file, source: read(file) }));

// Sites exempt from the rule, as `file:function:kind` with the reason. A
// control() or end() sequence needs no entry: neither asks the policy, so the
// audit does not count them (see the helper).
const EXEMPT = new Map([
 ['src/runtime/handler/ws.js:<module> -> setIdleHandler:callback',
  'the boundary runs this stored callback once per drained socket inside its own operation'],
 ['src/runtime/handler/platform.js:platform.topic -> createTopicHelperCache:callback',
  'the helper stores publish; each scoped-topic call is one publish']
]);

// The scopes each surface opens, so one removed or added is a reviewed change.
const SCOPES = {
 'src/runtime/handler/coalesced.js': 1,
 'src/runtime/handler/platform.js': 8,
 'src/runtime/handler/resume-buffer.js': 1,
 'src/runtime/handler/ws.js': 1
};

const key = (site) => site.file + ':' + site.fn + ':' + site.kind;
const audit = (modules) => auditDeliveryScopes(modules).unscoped.map(key).sort();
const one = (body, file = 'src/fixture.js') => audit([{ file, source: 'const deliveryAuthorization = createDeliveryAuthorization();\n' + body }]);

describe('delivery authorization fan-out scopes', () => {
	it('scopes every multi-frame call on every production delivery path', () => {
		const { unscoped, scopes, decidingCalls } = auditDeliveryScopes(sources());
		const open = unscoped.filter((site) => !EXEMPT.has(key(site)));
		expect(open.map((site) => key(site) + ' line ' + site.line)).toEqual([]);
		for (const exempt of EXEMPT.keys()) expect(unscoped.map(key), exempt + ' is no longer reported').toContain(exempt);
		expect(Object.fromEntries([...scopes].filter(([, n]) => n > 0))).toEqual(SCOPES);
		for (const file of ['src/runtime/handler/platform.js', 'src/runtime/handler/resume-buffer.js', 'src/runtime/handler/coalesced.js']) {
			expect(decidingCalls.get(file), file).toBeGreaterThan(0);
		}
	});

	it('recognizes only the boundary-owned deferred operation callback', () => {
		expect(one('export function nested(ws, frame) { deliveryAuthorization.deferOperation(() => deliveryAuthorization.send(ws, frame)); }')).toEqual([]);
		expect(one('export function nested(ws, frame) { other.deferOperation(() => deliveryAuthorization.send(ws, frame)); }'))
			.toEqual(['src/fixture.js:nested -> deferOperation:callback']);
	});

	it('reports a loop, a callback and a sequence of deciding calls outside a scope', () => {
		const file = 'src/fixture.js';
		expect(one(`
			export function loop(sockets, frame) {
				for (const ws of sockets) deliveryAuthorization.send(ws, frame);
			}
			export function callback(sockets, frame) {
				return sockets.map((ws) => deliveryAuthorization.sendReplaceable(ws, frame));
			}
			export function sequence(app, sockets, frame) {
				deliveryAuthorization.publish(app, sockets, 'a', frame);
				if (frame) deliveryAuthorization.publish(app, sockets, 'b', frame);
			}
		`)).toEqual([file + ':callback -> map:callback', file + ':loop:loop', file + ':sequence:sequence'].sort());
	});

	it('counts scopes with the deciding calls beside them, one unit each', () => {
		const file = 'src/fixture.js';
		const scope = (inner) => `{ const s = deliveryAuthorization.begin(); try { ${inner} } finally { deliveryAuthorization.finish(s); } }`;
		// Two cohorts in two scopes: the first cohort's nested publish runs before the second.
		expect(one(`export function cohorts(app, c, f1, f2) {
			${scope('deliveryAuthorization.publish(app, c, "bin", f1);')}
			${scope('deliveryAuthorization.publish(app, c, "json", f2);')}
		}`)).toEqual([file + ':cohorts:sequence']);
		// A scope per iteration is no scope for the call.
		expect(one(`export const platform = {
			publish(t, f) { return deliveryAuthorization.publish(null, [], t, f); },
			many(messages) { for (const m of messages) ${scope('platform.publish(m.topic, m.data);')} }
		};`)).toEqual([file + ':platform.many:loop']);
		// A scope followed by a deciding call outside it.
		expect(one(`export function tail(app, c, a, b) {
			${scope('deliveryAuthorization.publish(app, c, "t", a);')}
			deliveryAuthorization.publish(app, c, "t", b);
		}`)).toEqual([file + ':tail:sequence']);
		// Exclusive branches that each return after one scope are one unit.
		expect(one(`export function branches(app, c, a, b) {
			if (a) { ${scope('deliveryAuthorization.publish(app, c, "x", a); return true;')} }
			${scope('deliveryAuthorization.publish(app, c, "y", b);')}
		}`)).toEqual([]);
	});

	it('follows named callbacks, call and apply, and switch cases that fall through', () => {
		const file = 'src/fixture.js';
		expect(one(`function each(ws) { deliveryAuthorization.send(ws, 'f'); }
			export function named(sockets) { sockets.forEach(each); }`)).toEqual([file + ':named -> forEach:callback']);
		expect(one(`function sendOne(ws) { deliveryAuthorization.send(ws, 'f'); }
			export function called(sockets) { for (const ws of sockets) sendOne.call(null, ws); }
			export function applied(sockets) { for (const ws of sockets) sendOne.apply(null, [ws]); }`))
			.toEqual([file + ':applied:loop', file + ':called:loop']);
		expect(one(`export function fall(k, ws) {
			switch (k) { case 1: deliveryAuthorization.send(ws, 'a'); case 2: deliveryAuthorization.send(ws, 'b'); }
		}`)).toEqual([file + ':fall:sequence']);
		expect(one(`export function broken(k, ws) {
			switch (k) { case 1: deliveryAuthorization.send(ws, 'a'); break; case 2: deliveryAuthorization.send(ws, 'b'); }
		}`)).toEqual([]);
	});

	it('refuses the gate under another name and its methods read without a call', () => {
		const file = 'src/fixture.js';
		expect(one(`export function aliased(s) { const gate = deliveryAuthorization; for (const ws of s) gate.send(ws, 'f'); }`))
			.toEqual([file + ':aliased:alias']);
		expect(one(`export function destructured(s) { const { send } = deliveryAuthorization; for (const ws of s) send(ws, 'f'); }`))
			.toEqual([file + ':destructured:alias']);
		expect(one(`export function extracted(s) { const send = deliveryAuthorization.send; for (const ws of s) send(ws, 'f'); }`))
			.toEqual([file + ':extracted:alias']);
		// Reads that are not methods, and the factory and import bindings, are the gate's own.
		expect(audit([{ file, source: `import { deliveryAuthorization } from './delivery-authorization.js';
			export const armed = () => deliveryAuthorization.armed;` }])).toEqual([]);
	});

	it('exempts deferred and once-only callees only in their member positions', () => {
		const file = 'src/fixture.js';
		// A local helper named like an exempt method runs its callback repeatedly.
		expect(one(`function run(list, fn) { for (const x of list) fn(x); }
			export function helper(sockets) { run(sockets, (ws) => deliveryAuthorization.send(ws, 'f')); }`))
			.toEqual([file + ':helper -> run:callback']);
		expect(one(`function setTimer(list, fn) { for (const x of list) fn(x); }
			export function shadowed(sockets) { setTimer(sockets, (ws) => deliveryAuthorization.send(ws, 'f')); }`))
			.toEqual([file + ':shadowed -> setTimer:callback']);
		// The callbacks themselves are not reported; the loop inside the promise
		// callback still is.
		expect(one(`export function exempt(ws, sockets, promise) {
			ws.cork(() => deliveryAuthorization.send(ws, 'f'));
			promise.then(() => { for (const s of sockets) deliveryAuthorization.send(s, 'f'); });
			for (const s of sockets) setTimeout(() => deliveryAuthorization.send(s, 'f'), 10);
		}`)).toEqual([file + ':exempt:loop']);
	});

	it('takes the control lane only from the outbound kind parameter', () => {
		const file = 'src/fixture.js';
		const outbound = `const OUTBOUND_CONTROL = 1;
			function outbound(ws, frame, kind) { return kind === OUTBOUND_CONTROL ? deliveryAuthorization.control(ws, frame) : deliveryAuthorization.send(ws, frame); }
			function other(ws, flag, frame) { return deliveryAuthorization.send(ws, frame); }\n`;
		expect(one(outbound + `export function advise(sockets, frame) {
			for (const ws of sockets) {
				deliveryAuthorization.control(ws, frame);
				deliveryAuthorization.end(ws, 1001, 'Server draining');
				outbound(ws, frame, OUTBOUND_CONTROL);
			}
		}`)).toEqual([]);
		// The lane constant in any other position is no control send.
		expect(one(outbound + `export function misplaced(sockets, frame) {
			for (const ws of sockets) other(ws, OUTBOUND_CONTROL, frame);
		}`)).toEqual([file + ':misplaced:loop']);
	});

	it('accepts only the exact scope shape around the whole call', () => {
		const file = 'src/fixture.js';
		const scoped = (open, between = '') => `
			export function walk(sockets, frame) {
				${open}${between}
				try {
					for (const ws of sockets) deliveryAuthorization.send(ws, frame);
				} finally {
					deliveryAuthorization.finish(fanout);
				}
			}
		`;
		expect(one(scoped('const fanout = deliveryAuthorization.begin();'))).toEqual([]);
		expect(one(scoped('const fanout = false;'))).toEqual([file + ':walk:loop']);
		expect(one(scoped('const fanout = deliveryAuthorization.begin();', ' let other;'))).toEqual([file + ':walk:loop']);
		expect(one(scoped('const fanout = deliveryAuthorization.begin(); const other = fanout;').replace('finish(fanout)', 'finish(other)')))
			.toEqual([file + ':walk:loop']);
	});

	it('follows local helpers, platform methods and imports between the audited files', () => {
		const helper = 'src/runtime/handler/helper.js';
		const caller = 'src/runtime/handler/caller.js';
		const helperSource = `
			import { deliveryAuthorization } from './delivery-authorization.js';
			export function fanOut(sockets, frame) {
				for (const ws of sockets) deliveryAuthorization.send(ws, frame);
			}
		`;
		const callerSource = (body) => `
			import { deliveryAuthorization } from './delivery-authorization.js';
			import { fanOut } from './helper.js';
			export const platform = {
				publish(topic, frame) { return deliveryAuthorization.publish(null, [], topic, frame); },
				many(topics, frame) { ${body} }
			};
		`;
		const scopedCall = `const fanout = deliveryAuthorization.begin(); try { fanOut([], frame); } finally { deliveryAuthorization.finish(fanout); }`;
		expect(audit([{ file: helper, source: helperSource }, { file: caller, source: callerSource(scopedCall) }])).toEqual([]);
		expect(audit([{ file: helper, source: helperSource }, { file: caller, source: callerSource(scopedCall + ' fanOut([], frame);') }]))
			.toEqual([caller + ':platform.many:sequence', helper + ':fanOut:loop'].sort());
		expect(audit([{ file: helper, source: helperSource }, { file: caller, source: callerSource('for (const t of topics) platform.publish(t, frame);') }]))
			.toEqual([caller + ':platform.many:loop', helper + ':fanOut:loop'].sort());
	});

	it('reports a production fan-out whose scope is removed', () => {
		const platform = 'src/runtime/handler/platform.js';
		const source = read(platform);
		const batch = source.indexOf('\tpublishBatched(messages, options) {');
		const open = source.indexOf('const deliveryOperation = deliveryAuthorization.begin();', batch);
		expect(batch).toBeGreaterThan(0);
		expect(open).toBeGreaterThan(batch);
		const unscopedSource = source.slice(0, open) + 'const deliveryOperation = false;' + source.slice(open + 'const deliveryOperation = deliveryAuthorization.begin();'.length);
		const modules = sources().map((entry) => (entry.file === platform ? { file: platform, source: unscopedSource } : entry));
		expect(audit(modules)).toContain(platform + ':platform.publishBatched:loop');
	});
});

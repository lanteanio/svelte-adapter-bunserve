// Source audit for delivery authorization fan-out scopes.
//
// A policy may issue sends and publishes while it decides one frame; the gate
// runs them after the operation being decided. An adapter call that hands
// several frames to the gate must therefore open one scope for the whole call,
// written exactly as
//
//   const fanout = deliveryAuthorization.begin();
//   try { ... } finally { deliveryAuthorization.finish(fanout); }
//
// or a policy op issued while deciding its first frame overtakes its later
// frames. This audit parses each surface and reports:
//
// - a sequence: a function in which, on one path, two or more fan-out units
//   can run, where a unit is a scope or a deciding gate call outside one
//   (switch cases that fall through count together);
// - a loop whose body reaches a deciding gate call outside a scope, or
//   opens a scope (each iteration would be its own scope);
// - a callback that reaches a deciding gate call, inline or named, handed to
//   a function that may run it more than once (array iteration, a drain
//   helper); and
// - an alias: the gate bound or destructured under another name, or one of
//   its methods read without being called.
//
// A deciding gate call is deliveryAuthorization.send, .publish or
// .sendReplaceable, or a call to a function of the audited files that reaches
// one, followed through local functions, imports between audited files, the
// platform object's methods, and .call, .apply and .bind. control() and end()
// never ask the policy, so a sequence of them is not something a policy
// decides and needs no scope. A call that names the control lane in a
// function's `kind` parameter (createTestServer's outbound chokepoint) is a
// control send.
//
// A callback runs as an operation of its own when it is handed to a timer
// (setTimer, setTimeout, setImmediate, queueMicrotask, unless the file
// declares a function of that name) or to a promise or event method
// (x.then, x.catch, x.finally, x.on, x.once, x.addEventListener); it runs
// once, inside the call, when handed to x.cork, x.run or x.withContext.
// These exemptions apply only in those member positions.
//
// A function counts as scoped when every reference to it in the audited files
// is a call made inside a scope. This follows the shapes these files use; it
// is not a sound analysis of arbitrary JavaScript.

import * as acorn from 'acorn';

export const DECIDING_GATE_METHODS = new Set(['send', 'publish', 'sendReplaceable']);
const GATE_NAME = 'deliveryAuthorization';
const GATE_METHODS = new Set([...DECIDING_GATE_METHODS, 'control', 'end', 'begin', 'finish']);
const TIMER_CALLEES = new Set(['setTimer', 'setTimeout', 'setImmediate', 'setImmediateTimer', 'queueMicrotask']);
const LATER_METHODS = new Set(['then', 'catch', 'finally', 'on', 'once', 'addEventListener']);
const ONCE_METHODS = new Set(['cork', 'run', 'withContext']);
const CONTROL_LANE = 'OUTBOUND_CONTROL';
const LANE_PARAMETER = 'kind';

function isFunction(node) {
	return node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}

function isLoop(node) {
	return node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement' ||
		node.type === 'WhileStatement' || node.type === 'DoWhileStatement';
}

function children(node) {
	const out = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
		if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') out.push(child); }
		else if (value && typeof value.type === 'string') out.push(value);
	}
	return out;
}

function walk(node, visit, ancestors = []) {
	if (!node || typeof node.type !== 'string') return;
	visit(node, ancestors);
	const next = [...ancestors, node];
	for (const child of children(node)) walk(child, visit, next);
}

function isGateCall(node, methods) {
	return node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed &&
		node.callee.object.type === 'Identifier' && node.callee.object.name === GATE_NAME &&
		methods.has(node.callee.property.name);
}

function paramName(param) {
	if (param?.type === 'Identifier') return param.name;
	if (param?.type === 'AssignmentPattern' && param.left.type === 'Identifier') return param.left.name;
	return null;
}

function lineOf(source, offset) {
	let line = 1;
	for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * @param {Array<{ file: string, source: string }>} modules
 * @returns {{
 *   unscoped: Array<{ file: string, fn: string, kind: 'loop' | 'callback' | 'sequence' | 'alias', line: number }>,
 *   scopes: Map<string, number>,
 *   decidingCalls: Map<string, number>
 * }} what is unscoped, and per file how many scopes and direct deciding gate calls it saw
 */
export function auditDeliveryScopes(modules) {
	const files = modules.map(({ file, source }) => ({
		file, source, ast: acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
	}));
	const byFile = new Map(files.map((entry) => [entry.file, entry]));
	const resolveImport = (from, specifier) => {
		if (!specifier.startsWith('.')) return null;
		const parts = from.split('/');
		parts.pop();
		for (const piece of specifier.split('/')) {
			if (piece === '.') continue;
			if (piece === '..') parts.pop();
			else parts.push(piece);
		}
		const target = parts.join('/');
		return byFile.has(target) ? target : null;
	};

	// Function inventory: bare functions by name, the platform object's
	// methods, imports between audited files, and every function's name.
	const tables = new Map();
	const fnName = new Map();
	for (const { file, ast } of files) {
		const bare = new Map();
		const methods = new Map();
		const imports = new Map();
		const platformName = new Set(['this', 'platform']);
		const addBare = (name, node) => { if (!bare.has(name)) bare.set(name, []); bare.get(name).push(node); };
		walk(ast, (node, ancestors) => {
			if (node.type === 'ImportDeclaration') {
				const target = resolveImport(file, node.source.value);
				if (target) for (const s of node.specifiers) if (s.type === 'ImportSpecifier') imports.set(s.local.name, { file: target, name: s.imported.name });
			}
			if (node.type === 'FunctionDeclaration' && node.id) { addBare(node.id.name, node); fnName.set(node, node.id.name); }
			if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFunction(node.init)) {
				addBare(node.id.name, node.init);
				fnName.set(node.init, node.id.name);
			}
			if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'platform' &&
				node.init?.type === 'ObjectExpression') {
				for (const property of node.init.properties) {
					if (property.type !== 'Property' || property.computed) continue;
					const key = property.key.name ?? property.key.value;
					if (!methods.has(key)) methods.set(key, []);
					if (isFunction(property.value)) { methods.get(key).push(property.value); fnName.set(property.value, 'platform.' + key); }
					else if (property.value.type === 'Identifier') methods.get(key).push({ alias: property.value.name });
				}
			}
			if (node.type === 'Property' && isFunction(node.value) && !fnName.has(node.value)) {
				const owner = ancestors.at(-2);
				const ownerName = owner?.type === 'VariableDeclarator' && owner.id.type === 'Identifier' ? owner.id.name + '.' : '';
				fnName.set(node.value, ownerName + (node.key.name ?? node.key.value));
			}
		});
		for (const [local, target] of imports) if (target.name === 'platform') platformName.add(local);
		tables.set(file, { bare, methods, imports, platformName });
	}

	// Whether an enclosing function binds this name itself (a parameter or a
	// declaration in its body), shadowing the file's function of that name.
	function shadowed(name, ancestors) {
		for (const fn of ancestors) {
			if (!isFunction(fn)) continue;
			for (const param of fn.params) if (bindsName(param, name)) return true;
			if (fn.body.type !== 'BlockStatement') continue;
			for (const statement of fn.body.body) {
				if (statement.type === 'VariableDeclaration' && statement.declarations.some((d) => bindsName(d.id, name) && !isFunction(d.init))) return true;
			}
		}
		return false;
	}
	function bindsName(pattern, name) {
		if (!pattern) return false;
		if (pattern.type === 'Identifier') return pattern.name === name;
		if (pattern.type === 'AssignmentPattern') return bindsName(pattern.left, name);
		if (pattern.type === 'RestElement') return bindsName(pattern.argument, name);
		if (pattern.type === 'ArrayPattern') return pattern.elements.some((e) => bindsName(e, name));
		if (pattern.type === 'ObjectPattern') return pattern.properties.some((p) => bindsName(p.value ?? p.argument, name));
		return false;
	}

	// The functions a name or member names.
	function named(file, node, ancestors = []) {
		const table = tables.get(file);
		if (node.type === 'Identifier') {
			if (shadowed(node.name, ancestors)) return [];
			const local = table.bare.get(node.name);
			if (local) return local.map((fn) => ({ file, fn }));
			const imported = table.imports.get(node.name);
			if (imported) return (tables.get(imported.file).bare.get(imported.name) ?? []).map((fn) => ({ file: imported.file, fn }));
			return [];
		}
		if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' &&
			table.platformName.has(node.object.name)) {
			const owner = node.object.name === 'this' || node.object.name === 'platform' || !table.imports.has(node.object.name)
				? file
				: table.imports.get(node.object.name).file;
			const ownerTable = tables.get(owner);
			const found = [];
			for (const method of ownerTable.methods.get(node.property.name) ?? []) {
				if (method.alias) for (const fn of ownerTable.bare.get(method.alias) ?? []) found.push({ file: owner, fn });
				else found.push({ file: owner, fn: method });
			}
			return found;
		}
		if (isFunction(node)) return [{ file, fn: node }];
		return [];
	}

	// Which functions a call may run. `f.call(t, ...)`, `f.apply(t, ...)` and
	// `f.bind(t)(...)` run f. A target whose `kind` parameter receives the
	// control lane is a control send.
	function targets(file, call, ancestors = []) {
		let callee = call.callee;
		let args = call.arguments;
		if (callee.type === 'CallExpression' && callee.callee.type === 'MemberExpression' && !callee.callee.computed &&
			callee.callee.property.name === 'bind') {
			args = callee.arguments.slice(1).concat(args);
			callee = callee.callee.object;
		} else if (callee.type === 'MemberExpression' && !callee.computed &&
			(callee.property.name === 'call' || callee.property.name === 'apply') && named(file, callee.object).length > 0) {
			args = callee.property.name === 'call' ? args.slice(1) : [];
			callee = callee.object;
		}
		return named(file, callee, ancestors).filter(({ fn }) => {
			const lane = fn.params.findIndex((param) => paramName(param) === LANE_PARAMETER);
			const argument = lane === -1 ? undefined : args[lane];
			return !(argument?.type === 'Identifier' && argument.name === CONTROL_LANE);
		});
	}

	const allFunctions = [];
	for (const { file, ast } of files) walk(ast, (node) => { if (isFunction(node)) allFunctions.push({ file, fn: node }); });
	const reaching = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		for (const { file, fn } of allFunctions) {
			if (reaching.has(fn)) continue;
			let reaches = false;
			walk(fn.body, (node, ancestors) => {
				if (reaches || node.type !== 'CallExpression') return;
				if (isGateCall(node, DECIDING_GATE_METHODS) || targets(file, node, [fn, ...ancestors]).some((t) => reaching.has(t.fn))) reaches = true;
			});
			if (reaches) { reaching.add(fn); changed = true; }
		}
	}
	const reachingCall = (file, node) => node.type === 'CallExpression' &&
		(isGateCall(node, DECIDING_GATE_METHODS) || targets(file, node).some((t) => reaching.has(t.fn)));

	// Scopes: `const x = deliveryAuthorization.begin();` directly followed by a
	// try whose finally calls deliveryAuthorization.finish(x).
	const scopeBlocks = new Set();
	for (const { ast } of files) {
		walk(ast, (node) => {
			const list = node.type === 'BlockStatement' || node.type === 'Program' ? node.body
				: node.type === 'SwitchCase' ? node.consequent : null;
			if (!list) return;
			for (let i = 0; i + 1 < list.length; i++) {
				const declaration = list[i];
				const attempt = list[i + 1];
				if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const' || declaration.declarations.length !== 1) continue;
				const declarator = declaration.declarations[0];
				if (declarator.id.type !== 'Identifier' || !isGateCall(declarator.init, new Set(['begin'])) ||
					declarator.init.arguments.length !== 0) continue;
				if (attempt.type !== 'TryStatement' || !attempt.finalizer) continue;
				const closes = attempt.finalizer.body.some((statement) => statement.type === 'ExpressionStatement' &&
					isGateCall(statement.expression, new Set(['finish'])) &&
					statement.expression.arguments.length === 1 &&
					statement.expression.arguments[0].type === 'Identifier' &&
					statement.expression.arguments[0].name === declarator.id.name);
				if (closes) scopeBlocks.add(attempt.block);
			}
		});
	}

	// Functions every reference to which is a scoped call.
	const references = new Map();
	for (const { file, ast } of files) {
		walk(ast, (node, ancestors) => {
			if (node.type !== 'Identifier') return;
			const parent = ancestors.at(-1);
			if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
			if (parent?.type === 'Property' && parent.key === node && !parent.shorthand) return;
			if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
			if (parent?.type === 'FunctionDeclaration' && parent.id === node) return;
			if (parent?.type === 'ImportSpecifier' || parent?.type === 'ExportSpecifier') return;
			let call = parent?.type === 'CallExpression' && parent.callee === node ? parent : null;
			// `f.call(...)` and `f.apply(...)` call f.
			const grand = ancestors.at(-2);
			if (!call && parent?.type === 'MemberExpression' && parent.object === node && !parent.computed &&
				(parent.property.name === 'call' || parent.property.name === 'apply') &&
				grand?.type === 'CallExpression' && grand.callee === parent) call = grand;
			for (const target of named(file, node, ancestors)) {
				if (!references.has(target.fn)) references.set(target.fn, []);
				references.get(target.fn).push({ call, ancestors: [...ancestors, node] });
			}
		});
	}
	const scopedFunctions = new Set();
	const insideScope = (ancestors) => ancestors.some((node) => scopeBlocks.has(node) || scopedFunctions.has(node));
	changed = true;
	while (changed) {
		changed = false;
		for (const { fn } of allFunctions) {
			if (scopedFunctions.has(fn)) continue;
			const refs = references.get(fn);
			if (!refs || refs.length === 0) continue;
			if (refs.every((ref) => ref.call !== null && insideScope(ref.ancestors))) { scopedFunctions.add(fn); changed = true; }
		}
	}

	// A callback handed to this call runs later, or once inside it.
	function exemptCallee(file, call) {
		const callee = call.callee;
		if (callee.type === 'MemberExpression' && !callee.computed) {
			return (callee.object.type === 'Identifier' && callee.object.name === GATE_NAME && callee.property.name === 'deferOperation') ||
				LATER_METHODS.has(callee.property.name) || ONCE_METHODS.has(callee.property.name);
		}
		return callee.type === 'Identifier' && TIMER_CALLEES.has(callee.name) && !tables.get(file).bare.has(callee.name);
	}
	// The reaching functions an argument hands over, inline or by name.
	const handedOver = (file, argument, ancestors) => (isFunction(argument) || argument.type === 'Identifier' ||
		argument.type === 'MemberExpression' ? named(file, argument, ancestors) : []).filter((t) => reaching.has(t.fn));

	// Paths: the most fan-out units one run of a statement makes, a unit being
	// a scope or a deciding call outside one, split into paths that fall
	// through and paths that leave.
	const NONE = -Infinity;
	function expressionCount(file, node) {
		if (!node || typeof node.type !== 'string' || isFunction(node)) return 0;
		if (node.type === 'ConditionalExpression') {
			return expressionCount(file, node.test) + Math.max(expressionCount(file, node.consequent), expressionCount(file, node.alternate));
		}
		let own = reachingCall(file, node) ? 1 : 0;
		for (const child of children(node)) own += expressionCount(file, child);
		return own;
	}
	function statement(file, node) {
		if (!node) return { f: 0, e: NONE };
		switch (node.type) {
			case 'BlockStatement': return list(file, node.body);
			case 'ReturnStatement':
			case 'ThrowStatement': return { f: NONE, e: expressionCount(file, node.argument) };
			case 'BreakStatement':
			case 'ContinueStatement': return { f: NONE, e: 0 };
			case 'IfStatement': {
				const t = expressionCount(file, node.test);
				const c = statement(file, node.consequent);
				const a = node.alternate ? statement(file, node.alternate) : { f: 0, e: NONE };
				return { f: t + Math.max(c.f, a.f), e: t + Math.max(c.e, a.e) };
			}
			case 'TryStatement': {
				// A scope is one unit whatever runs inside it; whether it falls
				// through or leaves is its block's.
				if (scopeBlocks.has(node.block)) {
					const inner = statement(file, node.block);
					return { f: inner.f === NONE ? NONE : 1, e: inner.e === NONE ? NONE : 1 };
				}
				const t = statement(file, node.block);
				const worst = Math.max(t.f, t.e, 0);
				const c = node.handler ? statement(file, node.handler.body) : null;
				const fin = node.finalizer ? statement(file, node.finalizer) : { f: 0, e: NONE };
				const finCount = Math.max(fin.f, 0);
				return {
					f: Math.max(t.f, c ? worst + c.f : NONE) + finCount,
					e: Math.max(t.e, c ? worst + c.e : NONE) + finCount
				};
			}
			case 'ForStatement':
			case 'ForOfStatement':
			case 'ForInStatement':
			case 'WhileStatement':
			case 'DoWhileStatement': {
				const head = expressionCount(file, node.init) + expressionCount(file, node.test) +
					expressionCount(file, node.update) + expressionCount(file, node.right);
				const body = statement(file, node.body);
				return { f: head + Math.max(body.f, body.e, 0), e: head + body.e };
			}
			case 'SwitchStatement': {
				// A case that does not leave falls into the next one.
				const d = expressionCount(file, node.discriminant);
				let most = 0;
				let carry = NONE;
				for (const branch of node.cases) {
					const start = Math.max(0, carry);
					const run = list(file, branch.consequent);
					most = Math.max(most, start + Math.max(run.e, 0));
					carry = run.f === NONE ? NONE : start + run.f;
				}
				most = Math.max(most, carry);
				return { f: d + most, e: d + most };
			}
			case 'LabeledStatement': return statement(file, node.body);
			case 'FunctionDeclaration': return { f: 0, e: NONE };
			default: return { f: expressionCount(file, node), e: NONE };
		}
	}
	function list(file, statements) {
		let f = 0;
		let e = NONE;
		for (const s of statements) {
			if (f === NONE) break;
			const r = statement(file, s);
			e = Math.max(e, f + r.e);
			f = r.f === NONE ? NONE : f + r.f;
		}
		return { f, e };
	}

	const unscoped = [];
	const enclosingName = (ancestors) => {
		for (let i = ancestors.length - 1; i >= 0; i--) if (fnName.has(ancestors[i])) return fnName.get(ancestors[i]);
		for (let i = ancestors.length - 1; i >= 0; i--) if (isFunction(ancestors[i])) return '<anonymous>';
		return '<module>';
	};
	for (const { file, source, ast } of files) {
		walk(ast, (node, ancestors) => {
			const here = [...ancestors, node];
			const report = (kind, at = node) => unscoped.push({ file, fn: enclosingName(here), kind, line: lineOf(source, at.start) });
			// The gate is used only under its own name, and its methods only called.
			if (node.type === 'Identifier' && node.name === GATE_NAME) {
				const parent = ancestors.at(-1);
				const grand = ancestors.at(-2);
				const declared = (parent?.type === 'ImportSpecifier') ||
					(parent?.type === 'VariableDeclarator' && parent.id === node && parent.init?.type === 'CallExpression' &&
						parent.init.callee.type === 'Identifier' && parent.init.callee.name === 'createDeliveryAuthorization');
				const member = parent?.type === 'MemberExpression' && parent.object === node && !parent.computed;
				const called = member && grand?.type === 'CallExpression' && grand.callee === parent;
				if (!declared && !(member && (called || !GATE_METHODS.has(parent.property.name)))) report('alias');
			}
			if (isLoop(node) && !insideScope(here)) {
				let reaches = false;
				walk(node.body, (inner, innerAncestors) => {
					if (reaches) return;
					if (scopeBlocks.has(inner)) { reaches = true; return; }
					if (!reachingCall(file, inner) || insideScope(innerAncestors)) return;
					// A callback a deferred or once-only callee runs is not this loop's.
					const handled = innerAncestors.some((a, i) => isFunction(a) && innerAncestors[i - 1]?.type === 'CallExpression' &&
						exemptCallee(file, innerAncestors[i - 1]));
					if (!handled) reaches = true;
				});
				if (reaches) report('loop');
			}
			if (node.type === 'CallExpression' && !insideScope(here) && !exemptCallee(file, node)) {
				for (const argument of node.arguments) {
					if (handedOver(file, argument, here).some((t) => !scopedFunctions.has(t.fn))) {
						const callee = node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name
							: node.callee.type === 'Identifier' ? node.callee.name : '<call>';
						unscoped.push({ file, fn: enclosingName(here) + ' -> ' + callee, kind: 'callback', line: lineOf(source, argument.start) });
					}
				}
			}
			if (isFunction(node) && !scopedFunctions.has(node) && !insideScope(ancestors)) {
				const run = node.body.type === 'BlockStatement' ? list(file, node.body.body) : { f: expressionCount(file, node.body), e: NONE };
				if (Math.max(run.f, run.e) >= 2) report('sequence');
			}
		});
	}
	const scopes = new Map(files.map(({ file }) => [file, 0]));
	const decidingCalls = new Map(files.map(({ file }) => [file, 0]));
	for (const { file, ast } of files) {
		walk(ast, (node) => {
			if (scopeBlocks.has(node)) scopes.set(file, scopes.get(file) + 1);
			if (isGateCall(node, DECIDING_GATE_METHODS)) decidingCalls.set(file, decidingCalls.get(file) + 1);
		});
	}
	return { unscoped, scopes, decidingCalls };
}

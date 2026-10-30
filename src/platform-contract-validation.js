import { CANONICAL_PLATFORM_CONTRACTS } from './runtime/platform-contract-data.js';

const VALUE_KINDS = new Set(['function', 'object', 'string', 'number', 'boolean']);
const CONTEXTS = new Set(['worker', 'connection']);
// An npm package name, optionally followed by path segments: no empty, leading
// or trailing segment, so `svelte-adapter-bunserve/` cannot pass for a new name.
const ADAPTER_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const RESERVED_NAMESPACE = 'svelte-adapter-bunserve';

/** Stable `code` of a refused contract declaration. */
export const INVALID_PLATFORM_CONTRACT = 'INVALID_PLATFORM_CONTRACT';
/** Stable `code` of a platform that does not satisfy its contract. */
export const PLATFORM_ACTIVATION_FAILED = 'PLATFORM_ACTIVATION_FAILED';

// Declarations this module produced. They are deep-frozen data, so validating
// one again would only repeat work on every activation.
const defined = new WeakSet();

function invalidContract(detail) {
	const error = new TypeError('Invalid platform contract: ' + detail);
	error.code = INVALID_PLATFORM_CONTRACT;
	throw error;
}

function ownValues(value, label, keys) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidContract(label + ' must be an object.');
	let descriptors;
	try { descriptors = Object.getOwnPropertyDescriptors(value); }
	catch { invalidContract(label + ' cannot be inspected.'); }
	const result = Object.create(null);
	for (const name of Reflect.ownKeys(descriptors)) {
		if (typeof name !== 'string' || (keys && !keys.includes(name))) invalidContract(label + ' contains an unknown field.');
		const descriptor = descriptors[name];
		if (!Object.hasOwn(descriptor, 'value')) invalidContract(label + ' must contain data fields, not getters.');
		result[name] = descriptor.value;
	}
	return result;
}

/** Validate and freeze an adapter's explicit positive capability declaration. */
export function definePlatformContract(input) {
	if (defined.has(input)) return input;
	const contract = ownValues(input, 'contract', ['schemaVersion', 'adapter', 'members']);
	if (contract.schemaVersion !== 1) invalidContract('schemaVersion must be 1.');
	if (typeof contract.adapter !== 'string' || contract.adapter.length > 128 || !ADAPTER_NAME.test(contract.adapter)) {
		invalidContract('adapter must be a bounded package-style name.');
	}
	const source = ownValues(contract.members, 'members');
	const members = Object.create(null);
	for (const name of Object.keys(source).sort()) {
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') {
			invalidContract('members contains an invalid member name.');
		}
		const requirement = ownValues(source[name], 'member ' + name, ['kind', 'context']);
		if (typeof requirement.kind !== 'string') invalidContract('member ' + name + ' requires a value kind.');
		const kind = requirement.kind.endsWith('|null') ? requirement.kind.slice(0, -5) : requirement.kind;
		if (!VALUE_KINDS.has(kind)) invalidContract('member ' + name + ' has an unsupported value kind.');
		if (!CONTEXTS.has(requirement.context)) invalidContract('member ' + name + ' requires worker or connection context.');
		members[name] = Object.freeze({ kind: requirement.kind, context: requirement.context });
	}
	// The whole svelte-adapter-bunserve namespace is reserved: its canonical names
	// carry exactly the declarations this copy generated, and no other name
	// under it can be claimed by a caller.
	const reserved = contract.adapter === RESERVED_NAMESPACE || contract.adapter.startsWith(RESERVED_NAMESPACE + '/');
	if (reserved) {
		if (!Object.hasOwn(CANONICAL_PLATFORM_CONTRACTS, contract.adapter)) {
			invalidContract('adapter names under ' + RESERVED_NAMESPACE + ' are reserved for its own contracts.');
		}
		const canonical = CANONICAL_PLATFORM_CONTRACTS[contract.adapter].members;
		const differences = [...new Set([...Object.keys(canonical), ...Object.keys(members)])].filter(name =>
			!members[name] || !canonical[name] || members[name].kind !== canonical[name].kind || members[name].context !== canonical[name].context
		).sort();
		if (differences.length) invalidContract('reserved adapter ' + contract.adapter + ' requires canonical member declarations: ' + differences.join(', ') + '.');
	}
	const result = Object.freeze({ schemaVersion: 1, adapter: contract.adapter, members: Object.freeze(members) });
	defined.add(result);
	return result;
}

// A member counts when the platform or an object it inherits from defines it,
// short of the built-in prototypes: `toString` on a plain object is not a
// platform capability. A forwarding Proxy that answers `has` without
// describing properties counts through the `in` operator, except for a name
// the built-in prototypes also carry, which must be a real property.
function definesMember(platform, name) {
	for (let object = platform; object !== null; object = Object.getPrototypeOf(object)) {
		if (object === Object.prototype || object === Function.prototype) break;
		if (Object.hasOwn(object, name)) return true;
	}
	return !(name in Object.prototype) && !(name in Function.prototype) && name in platform;
}

/** Check top-level member kinds at activation without invoking platform methods. */
export function assertPlatformContract(platform, contract, options) {
	// Validate the declaration before touching the platform, including for callers
	// that construct an ordinary object instead of using definePlatformContract.
	const declared = definePlatformContract(contract);
	const settings = ownValues(options, 'options', ['context']);
	if (!CONTEXTS.has(settings.context)) invalidContract('options.context must be worker or connection.');
	const failures = [];
	const readable = platform !== null && (typeof platform === 'object' || typeof platform === 'function');
	for (const [name, requirement] of Object.entries(declared.members)) {
		if (requirement.context === 'connection' && settings.context === 'worker') continue;
		let value;
		try {
			if (!readable || !definesMember(platform, name)) {
				failures.push({ member: name, problem: 'missing', expected: requirement.kind });
				continue;
			}
			value = Reflect.get(platform, name, platform);
		} catch {
			failures.push({ member: name, problem: 'unreadable', expected: requirement.kind });
			continue;
		}
		const actual = value === null ? 'null' : typeof value;
		const accepted = requirement.kind.split('|');
		// A function is an object: an interface-typed member such as a metrics
		// registry may be implemented by a callable value.
		if (!accepted.includes(actual) && !(actual === 'function' && accepted.includes('object'))) {
			failures.push({ member: name, problem: 'wrong-kind', expected: requirement.kind });
		}
	}
	if (failures.length) {
		const text = failures.map((failure) => failure.member + ': ' +
			(failure.problem === 'missing' ? 'missing ' + failure.expected
				: failure.problem === 'unreadable' ? 'unreadable; expected ' + failure.expected
					: 'expected ' + failure.expected));
		const error = new TypeError('Platform activation failed for ' + declared.adapter + ' (' + settings.context + '): ' +
			text.join('; ') + '. Supply the complete platform or the explicit contract declared by its adapter.');
		error.code = PLATFORM_ACTIVATION_FAILED;
		error.adapter = declared.adapter;
		error.context = settings.context;
		error.failures = Object.freeze(failures.map((failure) => Object.freeze(failure)));
		throw error;
	}
}

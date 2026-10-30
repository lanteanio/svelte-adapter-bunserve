/** Top-level runtime kinds checked at activation, optionally accepting null. */
export type PlatformValueKind = 'function' | 'object' | 'string' | 'number' | 'boolean'
	| 'function|null' | 'object|null' | 'string|null' | 'number|null' | 'boolean|null';

/** Connection platforms also carry every worker-scoped requirement. */
export interface PlatformMemberRequirement {
	readonly kind: PlatformValueKind;
	readonly context: 'worker' | 'connection';
}

/** Positive capability declaration supplied explicitly by the adapter or caller. */
export interface PlatformContract {
	readonly schemaVersion: 1;
	readonly adapter: string;
	readonly members: Readonly<Partial<Record<string, PlatformMemberRequirement>>>;
}

/** `code` of the TypeError thrown for a refused contract declaration or options object. */
export const INVALID_PLATFORM_CONTRACT: 'INVALID_PLATFORM_CONTRACT';
/** `code` of the TypeError thrown when a platform does not satisfy its contract. */
export const PLATFORM_ACTIVATION_FAILED: 'PLATFORM_ACTIVATION_FAILED';

/** One unmet requirement on {@link PlatformActivationError.failures}. */
export interface PlatformActivationFailure {
	readonly member: string;
	readonly problem: 'missing' | 'unreadable' | 'wrong-kind';
	readonly expected: PlatformValueKind;
}

/** The TypeError {@link assertPlatformContract} throws for an incomplete platform. */
export interface PlatformActivationError extends TypeError {
	readonly code: 'PLATFORM_ACTIVATION_FAILED';
	readonly adapter: string;
	readonly context: 'worker' | 'connection';
	/** Every unmet requirement, in member-name order. */
	readonly failures: readonly PlatformActivationFailure[];
}

/**
 * Validate data-only schema fields and return an immutable declaration.
 * Names in the `svelte-adapter-bunserve` namespace are reserved: only its
 * canonical contracts, with exactly this copy's generated members, may use
 * them. Throws a TypeError with `code` {@link INVALID_PLATFORM_CONTRACT}.
 * Passing a declaration this function returned returns it unchanged.
 */
export function definePlatformContract<const Contract extends PlatformContract & {
	readonly members: Readonly<Record<string, PlatformMemberRequirement>>;
}>(contract: Contract): Readonly<{
	schemaVersion: 1;
	adapter: Contract['adapter'];
	members: { readonly [Member in keyof Contract['members']]: Readonly<Contract['members'][Member]> };
}>;

/**
 * Throw one deterministic TypeError listing all missing, unreadable or wrong-kind
 * members for this context. Reads live getters with their source receiver, never
 * invokes platform methods, and does not certify nested values or behavior. A
 * member counts when the platform or an object it inherits from defines it;
 * `Object.prototype` and `Function.prototype` members do not.
 *
 * @throws {PlatformActivationError} `code` {@link PLATFORM_ACTIVATION_FAILED}.
 * @throws {TypeError} `code` {@link INVALID_PLATFORM_CONTRACT}, before the
 *   platform is read, for an invalid contract or options object.
 */
export function assertPlatformContract(
	platform: unknown,
	contract: PlatformContract,
	options: { context: 'worker' | 'connection' }
): void;

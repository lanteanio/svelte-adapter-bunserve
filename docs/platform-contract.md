# Platform capability contracts

`svelte-adapter-bunserve/platform-contract` is a dependency-free entry point for
wrappers and consumers that activate against an adapter platform. Pass the
adapter's contract explicitly; a platform object's method presence does not
identify its adapter.

- `PLATFORM_MEMBERS` remains the frozen inventory of all public Bun `Platform`
  names, including inherited and contextual members. `PlatformMember` is its
  TypeScript name union. Symbol-keyed internals and plugin additions are outside
  that inventory.
- `PLATFORM_CONTRACT` declares the production requirements of this adapter,
  under the adapter name `svelte-adapter-bunserve`.
- `TEST_PLATFORM_CONTRACT` declares the capabilities of `createTestServer`,
  under `svelte-adapter-bunserve/testing`. Its pressure snapshot has no
  sampler, so it declares no `onPressure` or `onPublishRate` subscriptions.
- `definePlatformContract({ schemaVersion: 1, adapter, members })` validates and
  freezes a positive declaration. Each named member has a `kind` and `context`.
  Accepted kinds are `function`, `object`, `string`, `number`, `boolean`, or any
  of those followed by `|null`. `object` means any non-null object, so a
  callable value such as a function-based metrics registry satisfies it;
  `function` requires a callable. Contract fields must be data fields, not
  getters.
- `assertPlatformContract(platform, contract, { context })` validates the
  declaration before inspecting the platform. It throws one `TypeError` listing
  every missing, unreadable or wrong-kind member in deterministic name order.
  Error messages contain names and expected kinds, never platform values or
  getter exception text.
- Both failures carry a stable `code`, exported as constants: a refused
  declaration or options object throws `code: 'INVALID_PLATFORM_CONTRACT'`
  before the platform is read; an incomplete platform throws
  `code: 'PLATFORM_ACTIVATION_FAILED'` with `adapter`, `context` and a frozen
  `failures` list of `{ member, problem: 'missing' | 'unreadable' |
  'wrong-kind', expected }`. Branch on `code`, not on the message.
- A member counts when the platform or an object it inherits from defines it;
  `Object.prototype` and `Function.prototype` members never satisfy a
  requirement. A declaration `definePlatformContract` returned is not
  validated again, so activation checks cost a walk over the members only.

`context: 'worker'` requires worker members. `context: 'connection'` also
requires connection members. `requestId` is connection-scoped; it is absent on
an unbound worker platform. Validation reads getters with their original
receiver and never calls methods. It checks top-level runtime kinds, not nested
object shape, method signatures or behavior.

This adapter's contract declares only the members its production platform
provides. `batch`, `request`, `requestTopic`, `trace`, `traceContext`,
`introspect` and `diagnostic` are not part of the Bun `Platform` and are absent
from `PLATFORM_CONTRACT`, so activating against it neither requires nor
certifies them.

## Activating and forwarding

For the built runtime or the Vite dev plugin, which serves every production
member, pass `PLATFORM_CONTRACT`. For `createTestServer`, pass `TEST_PLATFORM_CONTRACT`.
Another adapter supplies its own positive contract; consumers use that
declaration without guessing from absent methods. A plugin or library that
activates against whatever platform it is handed takes the contract from its
caller and defaults to the contract of the adapter it ships with; a test that
runs it under `createTestServer` passes `TEST_PLATFORM_CONTRACT`, because the
production contract requires the sampler subscriptions the test server lacks.
A legacy caller can pass the authoritative contract explicitly even when its
platform object carries no contract association.

The whole `svelte-adapter-bunserve` namespace of adapter names is reserved.
Only its canonical contracts may use it, and they must carry exactly the member
declarations this copy of the package generated; a reduced or changed
declaration needs its own adapter name, so a caller cannot weaken the Bun
requirements while claiming that contract. The check is per copy: when an
application loads two copies of the adapter at different versions, a contract
from one is refused by the other if their members differ. Activate a platform
against the contract exported by the copy that serves it. Other adapters'
names, including `svelte-adapter-uws`, are reserved by their own packages:
validate a contract against the package that declares it.

```js
import { assertPlatformContract } from 'svelte-adapter-bunserve/platform-contract';

export function forwardPlatform(source, contract, context) {
	assertPlatformContract(source, contract, { context });
	const forwarded = {};
	for (const [name, requirement] of Object.entries(contract.members)) {
		if (context === 'worker' && requirement.context === 'connection') continue;
		Object.defineProperty(forwarded, name, {
			enumerable: true,
			get() {
				const value = Reflect.get(source, name, source);
				return typeof value === 'function' ? value.bind(source) : value;
			}
		});
	}
	return { platform: forwarded, contract };
}
```

Carry the explicit contract through each wrapper. Read through the source so
getters stay live and methods retain their original `this`. Do not copy getter
values into a snapshot or fill unsupported methods with no-op stubs. A wrapper
that replaces a method preserves its documented locality, return and failure
semantics. A consumer that needs an optional member can check the declaration
and report that requirement before activating that feature. Indexed members on
the shared `PlatformContract` type may be absent; declarations returned by
`definePlatformContract` retain the exact known keys.

## Declaring an alternate adapter

This small example declares only the two members its transport provides. Real
adapter declarations list all supported public members and their contexts.
Omitting a member means it is unsupported; it does not make an incomplete Bun
platform valid under `PLATFORM_CONTRACT`.

```js
import { definePlatformContract } from 'svelte-adapter-bunserve/platform-contract';

export const contract = definePlatformContract({
	schemaVersion: 1,
	adapter: 'example-adapter',
	members: {
		publish: { kind: 'function', context: 'worker' },
		traceContext: { kind: 'object|null', context: 'worker' }
	}
});
```

Extensions and realtime consumers import the same `PlatformContract` type and
validation function. Adapter-specific absences remain absent when its positive
declaration omits them. Plugin-added fields need the plugin's own contract.

The inventory and member kinds are generated from the complete public
`Platform` declaration. Connection scope comes from the members the worker
`TestPlatform` type omits, and the test contract from `TestConnectionPlatform`.
Run `node scripts/generate-platform-contract.js` after changing those types;
`npm run check:platform` rejects drift. Unit and Vite dev tests validate the
generated contract against the production worker and connection platforms, the
native live suite against a built server's connection platform, and the native
test-server checks cover both worker and connection contexts.

import type { Platform } from 'svelte-adapter-bunserve';
import { PLATFORM_MEMBERS, type PlatformMember } from 'svelte-adapter-bunserve/platform-contract';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
	(<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ExactMembers = Assert<Equal<PlatformMember, keyof Platform>>;
type ExactTuple = Assert<Equal<typeof PLATFORM_MEMBERS[number], keyof Platform>>;
const names: readonly PlatformMember[] = PLATFORM_MEMBERS;
const contextual: PlatformMember = 'requestId';
// @ts-expect-error Bun does not declare the lead's RPC request capability.
const unsupported: PlatformMember = 'request';
// @ts-expect-error The supported inventory is readonly.
PLATFORM_MEMBERS.push('requestId');
void names;
void contextual;

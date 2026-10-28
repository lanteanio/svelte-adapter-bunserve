import { nextCounter } from '$lib/server/shared-counter.js';
export const GET = () => Response.json({ value: nextCounter() });

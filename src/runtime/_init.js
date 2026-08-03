// Initialize SvelteKit's Server BEFORE any handler module that renders.
//
// $env/dynamic/private and $env/dynamic/public are runtime-populated by
// SvelteKit's Server.init({ env }) call - until init runs, the resolved
// env proxies are empty objects. Putting Server.init in this
// side-effect-bearing module and importing it first forces ESM to evaluate
// it before the handler graph (imports are evaluated depth-first in source
// order). Top-level `await server.init(...)` blocks the import chain until
// the env proxies are populated.
//
// No shims module: Bun ships the web platform globals (crypto, File, fetch,
// Request, Response, ReadableStream) natively.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'SERVER';
import { manifest, base } from 'MANIFEST';
import { processMonotonicNow } from './runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asset_dir = `${__dirname}/client${base}`;

const _t_init = processMonotonicNow();

/** @type {import('@sveltejs/kit').Server} */
export const server = new Server(manifest);

await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => Bun.file(`${asset_dir}/${file}`).stream()
});

console.log(`SvelteKit server initialized in ${(processMonotonicNow() - _t_init).toFixed(1)}ms`);

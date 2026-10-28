import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bunserve from '../../src/vite.js';
import { sveltekit } from '@sveltejs/kit/vite';

// Server entries a Vite plugin puts in front of the handler, the way the
// realtime layer's generated registry is: each one records that it ran and
// whether the WebSocket handler module had loaded yet, and
// test/live/extra-entries-check.mjs reads that back through /extra-entries.
//
// The names are chosen to fail the build's contract visibly. `__probe-B`
// sorts before `__probe-a` by code unit but after it in NTFS's
// case-insensitive listing, and they are added in that listing's order, so
// only the build's own sort puts them right. `__probe-it's` carries an
// apostrophe, which a quoted import specifier built from the name would end.
const EXTRA_ENTRIES = ['__probe-a', '__probe-B', "__probe-it's"];
// Written into the server output by hand, as a plugin may: a name Vite would
// have sanitized on the way in, so the build's own Rollup pass writes it as
// `__probe_x.js` and has to import it by that name.
const HAND_WRITTEN_ENTRY = '__probe#x';
const ENTRY_ID = '\0fixture-extra-entry:';

/**
 * @param {string} name
 * @param {string} envKeys - the expression the entry records as its count of
 *   dynamic env keys, or 'null' for one that cannot read the env
 */
const record = (name, envKeys) =>
	'(globalThis.__fixtureExtraEntries ??= []).push({ ' +
	`name: ${JSON.stringify(name)}, ` +
	'handlerLoaded: globalThis.__fixtureWsHandlerLoaded === true, ' +
	`dynamicEnvKeys: ${envKeys} });\n`;

/** @returns {import('vite').Plugin} */
function extraEntries() {
	let ssr = false;
	return {
		name: 'fixture-extra-entries',
		config(config, { command }) {
			if (command !== 'build' || !config.build?.ssr) return;
			config.build.rollupOptions ??= {};
			const input = config.build.rollupOptions.input;
			/** @type {Record<string, string>} */
			const named = typeof input === 'string' ? { index: input }
				: Array.isArray(input) ? Object.fromEntries(input.map((v, i) => [`entry${i}`, v]))
				: { ...(input ?? {}) };
			for (const name of EXTRA_ENTRIES) named[name] = ENTRY_ID + name;
			config.build.rollupOptions.input = named;
		},
		configResolved(resolved) {
			ssr = !!resolved.build.ssr;
		},
		resolveId(id) {
			return id.startsWith(ENTRY_ID) ? id : null;
		},
		load(id) {
			if (!id.startsWith(ENTRY_ID)) return null;
			return "import { env } from '$env/dynamic/private';\n" +
				record(id.slice(ENTRY_ID.length), 'Object.keys(env).length');
		},
		writeBundle(options) {
			if (!ssr || !options.dir) return;
			// Plain JavaScript, never seen by Vite, so it cannot import $env.
			writeFileSync(join(options.dir, `${HAND_WRITTEN_ENTRY}.js`), record(HAND_WRITTEN_ENTRY, 'null'));
		}
	};
}

export default {
	plugins: [sveltekit(), bunserve(), extraEntries()]
};

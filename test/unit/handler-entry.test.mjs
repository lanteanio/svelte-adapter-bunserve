import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { discoverHandler, legacyHandlerWarning } from '../../src/handler-entry.js';
import adapter from '../../src/index.js';
import { normalizeWsOptions } from '../../src/runtime/utils/ws-options.js';
import bunserve from '../../src/vite.js';
import { handlerTypescript } from '../../src/handler-typescript.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-entry-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');

test('handler discovery follows js, ts, mjs and respects an explicit file', () => {
	fs.writeFileSync(path.join(dir, 'src/ws-handler.js'), 'export const legacy = true;');
	assert.equal(discoverHandler(dir), null);
	assert.match(legacyHandlerWarning(dir), /Rename it to src\/hooks\.ws\.js/);
	assert.equal(legacyHandlerWarning(dir, 'src/ws-handler.js'), null);
	for (const ext of ['mjs', 'ts', 'js']) {
		const name = path.join(dir, `src/hooks.ws.${ext}`);
		fs.writeFileSync(name, 'export const hook = true;');
		assert.equal(discoverHandler(dir), name);
		assert.equal(legacyHandlerWarning(dir), null, 'a conventional hooks file supersedes legacy discovery');
	}
	assert.equal(discoverHandler(dir, 'custom.js'), path.join(dir, 'custom.js'));
});

test('Vite entry shares a lib module instance with the server entry', async () => {
	fs.writeFileSync(path.join(dir, 'src/lib/counter.js'), 'let n = 0; export const next = () => ++n;');
	fs.writeFileSync(path.join(dir, 'src/hooks.ws.js'), "export { next } from '$lib/counter.js';");
	fs.writeFileSync(path.join(dir, 'src/server.js'), "export { next } from '$lib/counter.js';");
	const plugin = bunserve();
	await plugin.configResolved({ root: dir, build: { ssr: true }, plugins: [] });
	const bundle = await rollup({ input: { server: path.join(dir, 'src/server.js') }, plugins: [plugin, {
		name: 'fixture-alias', resolveId(id) { if (id.startsWith('$lib/')) return path.join(dir, 'src/lib', id.slice(5)); }
	}] });
	const output = path.join(dir, 'output');
	try { await bundle.write({ dir: output, format: 'esm' }); } finally { await bundle.close(); }
	const server = await import(pathToFileURL(path.join(output, 'server.js')).href);
	const hooks = await import(pathToFileURL(path.join(output, 'ws-handler.js')).href);
	assert.equal(server.next(), 1);
	assert.equal(hooks.next(), 2);
	assert.equal(server.next(), 3);
});

test('adapter and plugin cannot silently select different hooks', async () => {
	const plugin = bunserve({ handler: 'src/hooks.ws.js' });
	await assert.rejects(() => plugin.configResolved({ root: dir, build: { ssr: true }, plugins: [{ api: { options: { kit: { adapter: {
		name: 'adapter-bunserve', websocketHandler: path.join(dir, 'custom.js')
	} } } } }] }), /named twice, and the two disagree/);
});

test('client builds never emit a server handler', async () => {
	const plugin = bunserve();
	await plugin.configResolved({ root: dir, build: {}, plugins: [] });
	let count = 0;
	plugin.buildStart.call({ emitFile() { count++; } });
	assert.equal(count, 0);
});


test('the handler fallback compiles TypeScript exports', async () => {
	const file = path.join(dir, 'typed.ts');
	fs.writeFileSync(file, 'export function upgrade({ cookies }: { cookies: Record<string, string> }) { return { id: cookies.sid }; }');
	const bundle = await rollup({ input: file, plugins: [handlerTypescript()] });
	let output;
	try { output = await bundle.generate({ format: 'esm' }); } finally { await bundle.close(); }
	const mod = await import('data:text/javascript;base64,' + Buffer.from(output.output[0].code).toString('base64'));
	assert.deepEqual(mod.upgrade({ cookies: { sid: 'one' } }), { id: 'one' });
});


test('WebSockets are opt-in and both boolean settings are accepted', async () => {
	assert.deepEqual(normalizeWsOptions(true).options, normalizeWsOptions({}).options);
	assert.deepEqual(normalizeWsOptions(false).options, normalizeWsOptions().options);
	for (const options of [{}, { websocket: false }, { websocket: true }, { websocket: {} }]) {
		const instance = adapter(options);
		const plugin = bunserve();
		await plugin.configResolved({ root: dir, build: { ssr: true }, plugins: [{ api: { options: { kit: { adapter: instance } } } }] });
		const emitted = [];
		plugin.buildStart.call({ emitFile(file) { emitted.push(file); } });
		assert.equal(emitted.some(file => file.type === 'chunk'), Boolean(options.websocket));
	}
});

test('missing relative handler paths fail by name for both config owners', async () => {
	for (const handler of ['./absent.js', '../absent.js']) {
		for (const owner of ['plugin', 'adapter']) {
			const plugin = bunserve(owner === 'plugin' ? { handler } : {});
			const instance = adapter({ websocket: owner === 'adapter' ? { handler } : true });
			await assert.rejects(() => plugin.configResolved({ root: dir, build: { ssr: true }, plugins: [{ api: { options: { kit: { adapter: instance } } } }] }), error => {
				assert.ok(error.message.includes(JSON.stringify(handler)));
				assert.match(error.message, /does not exist/);
				return true;
			});
		}
	}
});

test('bare handler specifiers reach the resolver instead of silently disabling WebSockets', async () => {
	const plugin = bunserve({ handler: 'missing.js' });
	await plugin.configResolved({ root: dir, build: { ssr: true }, plugins: [] });
	await assert.rejects(() => rollup({ input: path.join(dir, 'src/server.js'), plugins: [plugin] }), /missing\.js/);
});

test('virtual handler specifiers can resolve through another Vite plugin', async () => {
	const handler = 'virtual:ws';
	const plugin = bunserve({ handler });
	await plugin.configResolved({ root: dir, build: { ssr: true }, plugins: [] });
	const bundle = await rollup({ input: path.join(dir, 'src/server.js'), plugins: [plugin, {
		name: 'virtual-handler',
		resolveId(id) { if (id === path.resolve(dir, handler)) return '\0virtual:ws'; },
		load(id) { if (id === '\0virtual:ws') return 'export const virtualHook = true;'; }
	}] });
	try {
		const { output } = await bundle.generate({ format: 'esm' });
		assert.match(output.find(file => file.fileName === 'ws-handler.js').code, /virtualHook/);
	} finally { await bundle.close(); }
});

test('configured handler aliases resolve to one path and origin metadata', async () => {
	const file = path.join(dir, 'src/lib/ws.js');
	fs.writeFileSync(file, 'export const upgrade = () => ({});');
	const aliases = [{ find: '$lib', replacement: path.join(dir, 'src/lib') }];
	assert.equal(discoverHandler(dir, '$lib/ws.js', aliases), file);
	const plugin = bunserve({ handler: '$lib/ws.js' });
	await plugin.configResolved({ root: dir, build: { ssr: true }, resolve: { alias: aliases }, plugins: [{ api: { options: { kit: { adapter: adapter({ websocket: { handler: file } }) } } } }] });
	const emitted = [];
	plugin.buildStart.call({ emitFile(entry) { emitted.push(entry); } });
	assert.equal(emitted[0].id, file);
	assert.deepEqual(JSON.parse(emitted[1].source), { source: 'src/lib/ws.js', absolute: file, from: 'uws({ handler }) in vite.config.js' });
});


test('regular-expression aliases do not retain matching state', () => {
	const find = /^hooks/y;
	find.lastIndex = 4;
	const aliases = [{ find, replacement: 'src/lib' }];
	assert.equal(discoverHandler(dir, 'hooks/ws.js', aliases), path.join(dir, 'src/lib/ws.js'));
	assert.equal(discoverHandler(dir, 'hooks/ws.js', aliases), path.join(dir, 'src/lib/ws.js'));
	assert.equal(find.lastIndex, 4);
});

test('adapter builds opt-in endpoint options without a hooks module', async () => {
	const app = path.join(dir, 'empty-app');
	fs.mkdirSync(path.join(app, 'src'), { recursive: true });
	fs.writeFileSync(path.join(app, 'src/ws-handler.js'), 'throw new Error("legacy handler must not load");');
	fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
	const previous = process.cwd();
	try {
		process.chdir(app);
		for (const websocket of [undefined, false, true, {}, { handler: 'missing.js' }, { handler: './missing.js' }, { handler: '../missing.js' }]) {
			let replacements;
			const warnings = [];
			const builder = {
				config: { kit: { paths: { base: '' }, files: { lib: path.join(app, 'src/lib') }, alias: {} } },
				prerendered: { paths: [] },
				log: { minor() {}, warn(message) { warnings.push(message); }, info() {}, success() {} },
				getBuildDirectory() { return path.join(app, 'tmp'); },
				rimraf(file) { fs.rmSync(file, { recursive: true, force: true }); },
				mkdirp(file) { fs.mkdirSync(file, { recursive: true }); },
				writeClient(file) { this.mkdirp(file); },
				writePrerendered(file) { this.mkdirp(file); },
				writeServer(file) { fs.writeFileSync(path.join(file, 'index.js'), 'export class Server {}'); },
				generateManifest() { return '{}'; },
				getAppPath() { return '_app'; },
				copy(from, to, options) { replacements = options.replace; }
			};
			const build = () => adapter({ out: path.join(app, 'build'), precompress: false, staticHeaders: { 'cache-control': 'no-cache' }, websocket }).adapt(builder);
			if (websocket?.handler) {
				await assert.rejects(build, /missing\.js/);
			} else {
				await build();
				assert.ok(warnings.some(message => message.includes('Use staticCacheControl for path-specific cache policies.')));
				assert.equal(replacements.WS_OPTIONS !== 'null', Boolean(websocket), JSON.stringify(websocket));
				assert.equal(warnings.some(message => message.includes('src/ws-handler.js is no longer discovered')), websocket !== false, 'only explicitly disabled legacy discovery stays silent');
			}
		}
	} finally { process.chdir(previous); }
});


test('SvelteKit wildcard aliases match the Vite paths and keep exact aliases separate', () => {
	const aliases = { '$ws': 'src/exact.js', '$ws/*': 'src/lib/*', '$plain/*': 'src/lib' };
	assert.equal(discoverHandler(dir, '$ws', aliases), path.join(dir, 'src/exact.js'));
	assert.equal(discoverHandler(dir, '$ws/ws.js', aliases), path.join(dir, 'src/lib/ws.js'));
	assert.equal(discoverHandler(dir, '$plain/ws.js', aliases), path.join(dir, 'src/lib/ws.js'));
});

test('adapter validates emitted origins and resolves configured aliases in both build paths', async () => {
	const app = path.join(dir, 'origin-app');
	fs.mkdirSync(path.join(app, 'src/lib'), { recursive: true });
	fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
	fs.writeFileSync(path.join(app, 'src/lib/ws.js'), 'export const marker = "shared-handler";');
	fs.writeFileSync(path.join(app, 'src/hooks.ws.js'), 'export const conventional = true;');
	const previous = process.cwd();
	try {
		process.chdir(app);
		for (const scenario of ['mismatch', 'missing-origin', 'lib-plugin', 'wild-plugin', 'lib-fallback', 'wild-fallback', 'disabled', 'omitted']) {
			const warnings = [];
			let replacements;
			const named = scenario.startsWith('wild') ? '$ws/ws.js' : '$lib/ws.js';
			const websocket = scenario === 'disabled' ? false : scenario === 'omitted' ? undefined : { handler: named };
			const emitted = !scenario.includes('fallback') && !['disabled', 'omitted'].includes(scenario);
			const builder = {
				config: { kit: { paths: { base: '' }, files: { lib: path.join(app, 'src/lib') }, alias: { '$ws/*': 'src/lib/*' } } },
				prerendered: { paths: [] },
				log: { minor() {}, warn(message) { warnings.push(message); }, info() {}, success() {} },
				getBuildDirectory() { return path.join(app, 'tmp'); },
				rimraf(file) { fs.rmSync(file, { recursive: true, force: true }); },
				mkdirp(file) { fs.mkdirSync(file, { recursive: true }); },
				writeClient(file) { this.mkdirp(file); },
				writePrerendered(file) { this.mkdirp(file); },
				writeServer(file) {
					fs.writeFileSync(path.join(file, 'index.js'), 'export class Server {}');
					if (!emitted) return;
					fs.writeFileSync(path.join(file, 'ws-handler.js'), 'export const marker = "shared-handler";');
					if (scenario !== 'missing-origin') fs.writeFileSync(path.join(file, 'ws-handler.origin.json'), JSON.stringify({ absolute: path.join(app, scenario === 'mismatch' ? 'src/other.js' : 'src/lib/ws.js') }));
				},
				generateManifest() { return '{}'; },
				getAppPath() { return '_app'; },
				copy(from, to, options) { replacements = options.replace; }
			};
			const build = () => adapter({ out: path.join(app, 'build'), precompress: false, websocket }).adapt(builder);
			if (scenario === 'mismatch') { await assert.rejects(build, /does not match websocket.handler/); continue; }
			await build();
			assert.equal(warnings.some(message => message.includes('no origin metadata')), scenario === 'missing-origin', scenario);
			assert.equal(replacements.WS_OPTIONS !== 'null', Boolean(websocket), scenario);
			if (websocket) assert.match(fs.readFileSync(path.join(app, 'build/server/ws-handler.js'), 'utf8'), /shared-handler/, scenario);
		}
	} finally { process.chdir(previous); }
});

test('Vite resolves the adapter-owned alias before comparing it to the plugin handler', async () => {
	const file = path.join(dir, 'src/lib/ws.js');
	const plugin = bunserve({ handler: file });
	await plugin.configResolved({ root: dir, build: { ssr: true }, resolve: { alias: [{ find: '$lib', replacement: path.join(dir, 'src/lib') }] }, plugins: [{ api: { options: { kit: { adapter: adapter({ websocket: { handler: '$lib/ws.js' } }) } } } }] });
	const emitted = [];
	plugin.buildStart.call({ emitFile(entry) { emitted.push(entry); } });
	assert.equal(emitted[0].id, file);
});


test('Kit 3 adapter options and the SSR environment emit the configured handler', async () => {
 const file = path.join(dir, 'src/lib/ws.js');
 const plugin = bunserve({ handler: file });
 await plugin.configResolved({ root: dir, command: 'build', environments: { ssr: {} }, plugins: [{ api: { options: { adapter: adapter({ websocket: { handler: file } }) } } }] });
 const emitted = [];
 plugin.buildStart.call({ environment: { name: 'ssr' }, emitFile(entry) { emitted.push(entry); } });
 assert.equal(emitted[0].id, file);
});

test('flat and nested SvelteKit builders preserve the base and application paths', async () => {
	const app = path.join(dir, 'kit-builders');
	fs.mkdirSync(app, { recursive: true });
	fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
	const previous = process.cwd();
	try {
		process.chdir(app);
		for (const flat of [false, true]) {
			const kit = { paths: { base: '/foo' }, files: { lib: path.join(app, 'src/lib') }, alias: {} };
			const written = [];
			const builder = {
				config: flat ? kit : { kit }, prerendered: { paths: ['/foo/about'] },
				log: { minor() {}, warn() {}, info() {}, success() {} },
				getBuildDirectory() { return path.join(app, 'tmp'); },
				rimraf(file) { fs.rmSync(file, { recursive: true, force: true }); },
				mkdirp(file) { fs.mkdirSync(file, { recursive: true }); },
				writeClient(file) { written.push(file); this.mkdirp(file); },
				writePrerendered(file) { written.push(file); this.mkdirp(file); },
				writeServer(file) { fs.writeFileSync(path.join(file, 'index.js'), 'export class Server {}'); },
				generateManifest() { return '{}'; }, getAppPath() { return 'foo/_app'; }, copy() {}
			};
			await adapter({ out: 'build', precompress: false, websocket: false }).adapt(builder);
			assert.deepEqual(written, ['build/client/foo', 'build/prerendered/foo']);
			const manifest = fs.readFileSync(path.join(app, 'tmp/manifest.js'), 'utf8');
			assert.match(manifest, /export const base = "\/foo"/);
			assert.match(manifest, /export const appPath = "foo\/_app"/);
		}
	} finally { process.chdir(previous); }
});

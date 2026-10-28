import { detectSetCookieOnUpgrade } from './upgrade-cookie-scan.js';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { handlerTypescript } from './handler-typescript.js';
import { assertHandlerExists, discoverHandler, legacyHandlerWarning, resolveHandler, sameHandler } from './handler-entry.js';
import { normalizeStaticCacheControl, normalizeStaticHeaders, unresolvedImportAdvice } from './build-config.js';
import { listExcludedDotPaths } from './static-scan.js';
import { writeAndCloseRollupBundle, extraEntryImports } from './build-rollup-lifecycle.js';
import { assertScalarOptions, unknownOptionWarnings } from './adapter-options.js';
import { describeValue, normalizeWsOptions, readableCopy } from './runtime/utils/ws-options.js';
import { normalizeBodyLimits, serializeBodyLimits } from './runtime/utils/body-limits.js';

const runtimeDir = fileURLToPath(new URL('./runtime', import.meta.url).href);

// The simulation lane rides src/runtime in the package but never in a built
// app: it is reached by path from scripts/ and test/, and nothing the
// production server imports resolves any of these. Copying them into every
// build output would be dead weight, so the copy filters them out.
const SIM_LANE_FILES = new Set([
	'sim-core.js', 'sim-inmemory.js', 'sim-hooks.js',
	'invariants.js', 'auditor.js', 'steadystate.js'
]);

// Files larger than this stay out of the in-memory static cache and are
// served from disk via Bun.file (kernel sendfile). See the runtime's
// static-assets module. Fixed: the adapter this one mirrors declares no
// option for it, and an app that set one here could not carry its config back.
const STATIC_CACHE_MAX_FILE_SIZE = 4 * 1024 * 1024;

/** @type {import('./index.js').default} */
export default function (opts = {}) {
	// The whole bag is read ONCE into a plain copy before anything inspects
	// it. Every check below reads properties and asks Array.isArray, and both
	// throw natively on a value that will not be read - a revoked Proxy, a
	// throwing getter - naming neither the option nor what it accepts. The
	// copy makes every later read plain; a bag that cannot be read is refused
	// here, by name.
	// A CALLABLE is refused here rather than copied. `typeof` reports 'function'
	// for a revoked Proxy built over one, so the object-only branch below lets
	// it through untouched and the first property read is a native throw naming
	// nothing; an ordinary function would copy to `{}` and build an adapter on
	// silent defaults, which is worse than saying so.
	if (typeof opts === 'function') {
		throw new Error(
			`adapter options must be a plain object of options, got ${describeValue(opts)}.`
		);
	}
	// EVERY other non-object is refused here too, by name. `null` and the
	// primitives used to reach the destructuring below untouched: `null` threw
	// natively there ("Cannot read properties of null (reading 'out')", which
	// names neither the adapter nor the option), and a string, number or boolean
	// destructured to nothing at all - so `adapter('build')`, plainly meaning
	// `{ out: 'build' }`, built a server on silent defaults and reported no
	// problem. That is the same failure the callable branch above exists to
	// prevent, and the array branch below already refused its half of it.
	if (opts === null || typeof opts !== 'object') {
		throw new Error(
			`adapter options must be a plain object of options, got ${describeValue(opts)}.`
		);
	}
	const copied = readableCopy(opts);
	if (copied === null || Array.isArray(copied)) {
		throw new Error(
			`adapter options must be a plain object of options, got ${describeValue(opts)}.`
		);
	}
	opts = /** @type {any} */ (copied);
	// Unusable VALUES fail here, before any option is read: an option the
	// adapter cannot honour is not a forward-compatibility question, and the
	// factory is the closest point to the config that set it. Unknown KEYS are
	// only warned about, and that happens in adapt() where builder.log exists -
	// see below.
	assertScalarOptions(opts);

	const {
		out = 'build',
		precompress = true,
		envPrefix = '',
		healthCheckPath = '/healthz',
		readinessCheckPath = '/readyz',
		staticDotfiles = false,
		websocket
	} = opts;

	// Readiness-gated boot warmup: render the configured paths once during the
	// `starting` window so the SSR render path is warm before the readiness
	// probe reports ready. A load balancer routes the first real client the
	// moment readiness turns green, and a cold render costs about twenty times
	// a warm one - measured on THIS runtime, not carried over: 16.1-18.0 ms
	// cold against a 0.75-0.92 ms settled mean on Bun 1.3.14, 17-24x across
	// runs. Default on, warming '/'; `false` disables it; `{ paths }` names the
	// routes. Baked to the list of paths (empty when disabled).
	const warmupOption = opts.warmup === undefined ? true : opts.warmup;
	/** @type {string[]} */
	let warmupPaths;
	if (warmupOption === false) {
		warmupPaths = [];
	} else if (warmupOption === true) {
		warmupPaths = ['/'];
	} else if (warmupOption && typeof warmupOption === 'object' && Array.isArray(warmupOption.paths)) {
		if (!warmupOption.paths.every((p) => typeof p === 'string' && p[0] === '/')) {
			throw new Error(
				"warmup.paths must be an array of absolute pathname strings starting with '/' " +
				`(e.g. ['/', '/dashboard']), got ${describeValue(warmupOption.paths)}.`
			);
		}
		warmupPaths = warmupOption.paths.slice();
	} else {
		throw new Error(
			`warmup must be true, false, or an object like { paths: ['/'] }, got ${describeValue(warmupOption)}.`
		);
	}

	// Transport tuning for the WebSocket endpoint, plus the endpoint's own path
	// and handler module. Validated at factory time so a value Bun would refuse
	// (an idleTimeout above its 960s ceiling, say) fails the build with an
	// adapter-shaped message instead of crashing Bun.serve on boot.
	//
	// `path`, `handler` and `compressCredentialedResponses` live INSIDE this
	// block because svelte-adapter-uws declares them there, and a config has to
	// mean the same thing in both adapters to be portable between them.
	const wsResult = normalizeWsOptions(websocket);
	const websocketPath = wsResult.options.path;
	const compressCredentialedResponses = wsResult.options.compressCredentialedResponses;

	const wsTransportConfigured = Boolean(websocket);

	if (websocketPath === healthCheckPath || websocketPath === readinessCheckPath) {
		throw new Error(
			`adapter option \`websocket.path\` ('${websocketPath}') collides with a probe route. ` +
			'The probe routes are matched first, so the WebSocket endpoint would never be reached.'
		);
	}

	// The same collision, and the same reason: the probes are matched first, so
	// an auth preflight sharing a probe's path would be answered with the probe's
	// 200 and the sign-in would fail with nothing naming the cause.
	const websocketAuthPath = wsResult.options.authPath;
	if (websocketAuthPath === healthCheckPath || websocketAuthPath === readinessCheckPath) {
		throw new Error(
			`adapter option \`websocket.authPath\` ('${websocketAuthPath}') collides with a probe route. ` +
			'The probe routes are matched first, so the auth preflight endpoint would never be reached.'
		);
	}

	// Readiness probe path (distinct from the `healthCheckPath` liveness probe):
	// reports 503 once graceful shutdown begins so a load balancer drains the
	// instance. Default `/readyz`; set `false` to disable. Validated here so a
	// misconfiguration fails the build rather than silently no-op'ing.
	if (readinessCheckPath !== false) {
		if (typeof readinessCheckPath !== 'string' || readinessCheckPath[0] !== '/') {
			throw new Error(
				`readinessCheckPath must be an absolute path string starting with '/' ` +
				`(e.g. '/readyz'), or false to disable the readiness route - ` +
				`got ${describeValue(readinessCheckPath)}.`
			);
		}
		if (healthCheckPath !== false && readinessCheckPath === healthCheckPath) {
			throw new Error(
				`readinessCheckPath ('${readinessCheckPath}') must differ from healthCheckPath ('${healthCheckPath}') - ` +
				`liveness and readiness are distinct probes (a readiness 503 during drain must not trip a liveness restart).`
			);
		}
	}

	// Validate `staticHeaders` eagerly so a misshaped value fails before any
	// build work. The reserved-key warning needs builder.log, so it is emitted
	// inside adapt(); the throw-on-bad-shape path runs here at factory time.
	const staticHeadersResult = normalizeStaticHeaders(opts.staticHeaders);
	const staticCacheControl = normalizeStaticCacheControl(opts.staticCacheControl);
	const bodyLimits = normalizeBodyLimits(opts.bodyLimits);

	return {
		name: 'adapter-bunserve',
		envPrefix,
		bodyLimits,
		websocketHandler: websocket?.handler ?? null,
		websocketPath: websocket?.path ?? null,
		websocketAuthPath: websocket?.authPath ?? null,
		websocketMetrics: websocket?.metrics ?? null,
		websocketEnabled: Boolean(websocket),

		async adapt(builder) {
			const kitConfig = builder.config.paths ? builder.config : builder.config.kit;
			// Unknown top-level keys: warned, never fatal, so an app pinning an
			// older adapter than its config was written for still builds. Emitted
			// here rather than at factory time because this is where the builder's
			// logger exists, and a warning nobody sees is not a warning.
			for (const warning of unknownOptionWarnings(opts)) builder.log.warn(warning);

			const tmp = builder.getBuildDirectory('adapter-bunserve');

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${kitConfig.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${kitConfig.paths.base}`);

			if (precompress) {
				builder.log.minor('Compressing assets');
				await Promise.all([
					builder.compress(`${out}/client`),
					builder.compress(`${out}/prerendered`)
				]);
			}

			builder.log.minor('Building server');

			builder.writeServer(tmp);

			writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(kitConfig.paths.base)};`,
					`export const appPath = ${JSON.stringify(builder.getAppPath())};`
				].join('\n\n')
			);

			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

			/** @type {Record<string, string>} */
			const input = {
				index: `${tmp}/index.js`,
				manifest: `${tmp}/manifest.js`
			};

			const legacyWarning = websocket !== false ? legacyHandlerWarning(process.cwd(), websocket?.handler) : null;
			if (legacyWarning) builder.log.warn(legacyWarning);
			const wsHandlerPath = websocket ? discoverHandler(process.cwd(), websocket?.handler, {
				$lib: kitConfig.files.lib,
				...kitConfig.alias
			}) : null;
			const viteHandler = path.join(tmp, 'ws-handler.js');
			const hasViteHandler = Boolean(websocket) && existsSync(viteHandler);
			const hasWsHandler = hasViteHandler || wsHandlerPath !== null;
			if (!hasViteHandler && websocket?.handler) assertHandlerExists(wsHandlerPath, websocket.handler, 'websocket.handler');
			if (hasViteHandler) {
				const originFile = path.join(tmp, 'ws-handler.origin.json');
				if (existsSync(originFile) && websocket?.handler) {
					const built = JSON.parse(readFileSync(originFile, 'utf8'));
					if (typeof built.absolute !== 'string' || !sameHandler(wsHandlerPath, built.absolute)) {
						throw new Error('The bundled WebSocket handler does not match websocket.handler.');
					}
				}
				if (!existsSync(originFile)) builder.log.warn('The bundled WebSocket handler has no origin metadata; its configured source cannot be verified.');
				input['ws-handler'] = viteHandler;
			} else if (hasWsHandler) {
				input['ws-handler'] = wsHandlerPath;
				builder.log.warn('Add svelte-adapter-bunserve/vite to the Vite plugins to share modules between hooks.ws and server routes.');
			} else {
				writeFileSync(viteHandler, '// No WebSocket handler configured.\n');
				input['ws-handler'] = viteHandler;
				if (websocket?.handler) builder.log.warn('No WebSocket handler at ' + wsHandlerPath);
			}
			if (hasWsHandler) builder.log.minor('WebSocket handler: ' + (hasViteHandler ? 'built by Vite' : wsHandlerPath));
			for (const warning of wsResult.warnings) {
				builder.log.warn(`[adapter-bunserve] ${warning}`);
			}
			if (wsResult.unknownKeys.length) {
				builder.log.warn(
					`[adapter-bunserve] Unknown \`websocket\` option keys ignored: ${wsResult.unknownKeys.join(', ')}. ` +
					'Check for a typo - an unrecognized key is silently inert at runtime.'
				);
			}

			const metricsPath = websocket?.metrics;
			const metricsEntry = path.join(tmp, 'metrics-registry.js');
			if (metricsPath) {
				const resolved = resolveHandler(process.cwd(), metricsPath, { $lib: kitConfig.files.lib, ...kitConfig.alias });
				if (existsSync(metricsEntry)) {
					const originFile = path.join(tmp, 'metrics-registry.origin.json');
					if (existsSync(originFile)) {
						const origin = JSON.parse(readFileSync(originFile, 'utf8'));
						if (typeof origin.absolute !== 'string' || !sameHandler(resolved, origin.absolute)) {
							throw new Error('The bundled metrics registry does not match websocket.metrics.');
						}
					} else builder.log.warn('The bundled metrics registry has no origin metadata; its configured source cannot be verified.');
				} else {
					if (!existsSync(resolved)) throw new Error(`websocket.metrics module does not exist: ${resolved}`);
					writeFileSync(metricsEntry, `import * as m from ${JSON.stringify(resolved.replaceAll('\\', '/'))};\nconst pick = ns => ns.default ?? ns.metrics ?? ns.registry ?? null;\nexport default pick(m);\n`);
					builder.log.warn('websocket.metrics was bundled standalone. Scrape platform.metrics, or add svelte-adapter-bunserve/vite to share its registry with server routes.');
				}
			} else writeFileSync(metricsEntry, 'export default null;\n');
			input['metrics-registry'] = metricsEntry;

			if (builder.hasServerInstrumentationFile?.()) {
				input['instrumentation.server'] = `${tmp}/instrumentation.server.js`;
			}

			// Include extra entry files written by Vite plugins (e.g. __live-registry.js).
			// Only picks up __-prefixed files to avoid bundling SvelteKit internals.
			// Known entries are compared by full path, not by file name: the
			// WebSocket handler entry is the project's own file, outside tmp, and a
			// handler that happened to be named like an extra entry must not hide it.
			const knownEntries = new Set(Object.values(input).map(f => path.resolve(f)));
			/** @type {string[]} */
			const extraEntries = [];
			// Sorted, so the entries load in the same order on every filesystem: the
			// directory listing order is the filesystem's, and NTFS and ext4 disagree.
			for (const file of readdirSync(tmp).sort()) {
				if (file.startsWith('__') && file.endsWith('.js') && !knownEntries.has(path.resolve(tmp, file))) {
					const name = file.replace(/\.js$/, '');
					input[name] = `${tmp}/${file}`;
					extraEntries.push(name);
				}
			}

			/** @type {{ source: string, importer: string }[]} */
			const unresolvedImports = [];

			// Bundle the Vite output so that deployments only need
			// their production dependencies. Anything in devDependencies
			// will get included in the bundled code.
			const bundle = await rollup({
				input,
				external: [
					// dependencies could have deep exports, so we need a regex
					...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`)),
					// Bun's builtin modules ('bun', 'bun:sqlite', 'bun:ffi', ...)
					// resolve at runtime, never at bundle time
					/^bun(:.+)?$/
				],
				plugins: [
					...(!hasViteHandler ? [handlerTypescript()] : []),
					// SvelteKit's `$lib` alias. The server bundle produced by
					// writeServer has already had its aliases resolved by Vite,
					// but the WebSocket handler is a project source file rollup
					// reads directly, and `$lib` is ubiquitous in one.
					{
						name: 'adapter-bunserve-kit-alias',
						resolveId(source) {
							if (source === '$lib' || source.startsWith('$lib/')) {
								const libDir = kitConfig.files.lib;
								const rest = source === '$lib' ? '' : source.slice('$lib/'.length);
								return this.resolve(path.resolve(libDir, rest), undefined, { skipSelf: true });
							}
							// The project's own `kit.alias` entries. Without these a
							// handler importing through a configured alias resolves to
							// nothing, gets externalized, and fails at BOOT instead of
							// at build.
							for (const [from, to] of Object.entries(kitConfig.alias || {})) {
								const prefix = from.endsWith('/') ? from : from + '/';
								if (source === from) {
									return this.resolve(path.resolve(to), undefined, { skipSelf: true });
								}
								if (source.startsWith(prefix)) {
									const rest = source.slice(prefix.length);
									return this.resolve(path.resolve(to, rest), undefined, { skipSelf: true });
								}
							}
							return null;
						}
					},
					nodeResolve({
						preferBuiltins: true,
						exportConditions: ['bun', 'node'],
						extensions: ['.mjs', '.js', '.json', '.node', '.ts', '.mts', '.cts', '.tsx']
					}),
					commonjs({ strictRequires: true }),
					json()
				],
				// An import rollup cannot resolve is externalized by default, so
				// the build would report success and the output would fail at
				// boot with a bare unresolved specifier. That is the worst place
				// to find out. `$app/*` and `$env/*` are the realistic cases in a
				// WebSocket handler without the Vite plugin - virtual modules
				// they genuinely cannot be resolved - and this turns each into a
				// build error naming the file and the fix.
				onwarn(warning, handler) {
					if (warning.code === 'UNRESOLVED_IMPORT') {
						unresolvedImports.push({
							source: warning.exporter ?? String(warning.message),
							importer: warning.id ?? 'unknown'
						});
						return;
					}
					handler(warning);
				}
			});

			if (unresolvedImports.length) {
				try {
					await bundle.close();
				} catch {
					// The unresolved imports are the error worth reporting.
				}
				const list = unresolvedImports
					.map((u) => `  "${u.source}" imported by ${u.importer}`)
					.join('\n');
				// Both spellings of tmp, since a resolver reports an importer by its
				// real path.
				const advice = unresolvedImportAdvice(
					unresolvedImports.map((u) => u.importer),
					[path.resolve(tmp), realpathSync(tmp)]
				);
				throw new Error(
					`[adapter-bunserve] ${unresolvedImports.length} import(s) could not be resolved:\n${list}\n\n` +
					'These would be left as bare specifiers in the output and crash at startup rather than ' +
					`failing here. ${advice.join(' ')}`
				);
			}

			const written = await writeAndCloseRollupBundle(bundle, {
				dir: `${out}/server`,
				format: 'esm',
				sourcemap: true,
				chunkFileNames: 'chunks/[name]-[hash].js'
			});

			const handlerChunk = written.output.find(chunk => chunk.type === 'chunk' && chunk.fileName === 'ws-handler.js');
			if (handlerChunk && detectSetCookieOnUpgrade(handlerChunk.code)) {
				builder.log.warn('[adapter-bunserve] Your upgrade() hook attaches Set-Cookie to the 101 response via upgradeResponse(). This fails silently behind Cloudflare Tunnel and other strict edge proxies: the WebSocket opens, then closes with code 1006 before frames are exchanged. Move session cookie refreshes to authenticate() and opt in with connect({ auth: true }). This warning is safe to ignore if you do not deploy behind Cloudflare.');
			}

			// staticHeaders: app-chosen response headers for static and prerendered
			// assets (CSP, HSTS, X-Frame-Options, ...). These bypass the SvelteKit
			// `handle` hook, which only runs on the SSR path - so security headers
			// set there never reach static/prerendered responses. Reserved
			// transfer/caching headers are stripped (the handler owns them); warn
			// so a dropped override is never silent.
			if (staticHeadersResult.dropped.length) {
				builder.log.warn(
					`[adapter-bunserve] staticHeaders ignored: ${staticHeadersResult.dropped.join(', ')}. ` +
					'These transfer/caching/range headers are managed by the static file ' +
					'handler and cannot be overridden (content-type, content-encoding, etag, ' +
					'cache-control, vary, accept-ranges, ...). Use staticCacheControl for ' +
					'path-specific cache policies. Every other header is applied.'
				);
			}

			// Dotfiles are excluded from the static index by default, so a
			// dot-path in the output would 404 in production with nothing saying
			// why. Say so here, where the file is still in front of the developer.
			if (!staticDotfiles) {
				const outBase = kitConfig.paths.base;
				const refused = [...new Set([
					...listExcludedDotPaths(`${out}/client${outBase}`),
					...listExcludedDotPaths(`${out}/prerendered${outBase}`)
				])];
				if (refused.length) {
					// Every offender is named - a refused directory collapses to one
					// entry, so the list stays proportionate to what the developer
					// actually dropped into static/.
					builder.log.warn(
						`[adapter-bunserve] not served - dotfiles are refused by default (a top-level ` +
						`.well-known/ keeps serving its own non-dot files): ${refused.join(', ')}. ` +
						'Rename the file to serve it, or set staticDotfiles: true to serve every dotfile.'
					);
				}
			}

			builder.copy(runtimeDir, out, {
				filter: (file) => !SIM_LANE_FILES.has(path.basename(file)),
				replace: {
					ENV_PREFIX: JSON.stringify(envPrefix),
					BODY_LIMIT_RULES: serializeBodyLimits(bodyLimits),
					PRECOMPRESS: JSON.stringify(precompress),
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath),
					READINESS_CHECK_PATH: JSON.stringify(readinessCheckPath),
					WARMUP_PATHS: JSON.stringify(warmupPaths),
					STATIC_HEADERS: JSON.stringify(staticHeadersResult.headers),
					STATIC_CACHE_CONTROL: JSON.stringify(staticCacheControl),
					STATIC_CACHE_MAX: JSON.stringify(STATIC_CACHE_MAX_FILE_SIZE),
					STATIC_DOTFILES: JSON.stringify(staticDotfiles),
					HTTP_OPTIONS: JSON.stringify({
						compressCredentialedResponses: compressCredentialedResponses === true
					}),
					WS_PATH: JSON.stringify(websocketPath),
					// null switches the whole WebSocket surface off at runtime:
					// no upgrade lane, no websocket option set on Bun.serve, no
					// per-connection bookkeeping. An app with no handler and no
					// explicit `websocket` config pays nothing for realtime.
					//
					// Boolean true and an options object without a handler enable the built-in
					// control protocol even when no hooks module exists.
					WS_OPTIONS: hasWsHandler || wsTransportConfigured
						? JSON.stringify(wsResult.options)
						: 'null'
				}
			});

			// The output root's own package.json. `"type": "module"` makes the
			// output ESM regardless of what the app's package.json says, and
			// `"imports"` is what resolves the runtime's `#server`,
			// `#manifest` and `#ws-handler` specifiers to the generated
			// chunks - package imports, resolved by the nearest package.json,
			// which this file is for everything in the output. The
			// alternative, rewriting bare tokens during the copy, replaced
			// the token ANYWHERE it appeared (a comment reading "MANIFEST
			// ORDER FIRST" shipped mangled), and stubbing those tokens for
			// tests needed a resolver hook that Bun does not implement.
			writeFileSync(
				`${out}/package.json`,
				JSON.stringify(
					{
						type: 'module',
						imports: {
							'#server': './server/index.js',
							'#manifest': './server/manifest.js',
							'#ws-handler': './server/ws-handler.js',
						'#metrics-registry': './server/metrics-registry.js'
						}
					},
					null,
					'\t'
				) + '\n'
			);

			// The exact metadata that produced this server, for the boot
			// banner and diagnostics: the runtime reads its version and the
			// protocol revision from these FILES at runtime, never from
			// constants inlined at build time, so what it reports is what is
			// deployed - including after someone hand-patches a build.
			builder.mkdirp(`${out}/meta`);
			writeFileSync(
				`${out}/meta/package.json`,
				readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)))
			);
			writeFileSync(
				`${out}/meta/protocol.schema.json`,
				readFileSync(fileURLToPath(new URL('../protocol.schema.json', import.meta.url)))
			);

			// Import discovered __-prefixed entries so they execute at startup
			if (extraEntries.length > 0) {
				const entryImports = extraEntryImports(written, tmp, extraEntries);
				const indexPath = `${out}/index.js`;
				const indexContent = readFileSync(indexPath, 'utf8');
				writeFileSync(indexPath, entryImports + '\n' + indexContent);
				builder.log.minor(`Extra entries: ${extraEntries.join(', ')}`);
			}

			if (builder.hasServerInstrumentationFile?.()) {
				builder.instrument?.({
					entrypoint: `${out}/index.js`,
					instrumentation: `${out}/server/instrumentation.server.js`,
					module: {
						exports: ['host', 'port']
					}
				});
			}
		},

		supports: {
			read: () => true,
			instrumentation: () => true
		}
	};
}

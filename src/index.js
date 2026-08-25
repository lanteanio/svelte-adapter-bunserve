import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { normalizeStaticHeaders } from './build-config.js';
import { listExcludedDotPaths } from './static-scan.js';
import { assertScalarOptions, unknownOptionWarnings } from './adapter-options.js';
import { describeValue, normalizeWsOptions } from './runtime/utils/ws-options.js';

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
// static-assets module; overridable via the `staticCacheMaxFileSize` option.
const DEFAULT_STATIC_CACHE_MAX_FILE_SIZE = 4 * 1024 * 1024;

/** @type {import('./index.js').default} */
export default function (opts = {}) {
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
		staticCacheMaxFileSize = DEFAULT_STATIC_CACHE_MAX_FILE_SIZE,
		staticDotfiles = false,
		websocket
	} = opts;

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
	const websocketHandler = wsResult.options.handler;
	const compressCredentialedResponses = wsResult.options.compressCredentialedResponses;

	// Whether the app asked for a realtime endpoint AT ALL, as opposed to just
	// saying where one would live. `handler` and `path` are addresses, not
	// intent - see the WS_OPTIONS decision below.
	const wsTransportConfigured =
		websocket !== undefined &&
		Object.keys(websocket).some((key) => key !== 'handler' && key !== 'path' && key !== 'authPath');

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

	if (!Number.isInteger(staticCacheMaxFileSize) || staticCacheMaxFileSize <= 0) {
		throw new Error(
			`staticCacheMaxFileSize must be a positive integer byte count ` +
			`(files larger than this are served from disk via Bun.file instead of the in-memory cache) - ` +
			`got ${describeValue(staticCacheMaxFileSize)}.`
		);
	}

	// Validate `staticHeaders` eagerly so a misshaped value fails before any
	// build work. The reserved-key warning needs builder.log, so it is emitted
	// inside adapt(); the throw-on-bad-shape path runs here at factory time.
	const staticHeadersResult = normalizeStaticHeaders(opts.staticHeaders);

	return {
		name: 'adapter-bunserve',

		async adapt(builder) {
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
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

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
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
				].join('\n\n')
			);

			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

			/** @type {Record<string, string>} */
			const input = {
				index: `${tmp}/index.js`,
				manifest: `${tmp}/manifest.js`
			};

			// The WebSocket handler module. Zero-config: drop a src/ws-handler.js
			// into the project and the realtime surface turns on. When the file
			// is absent a stub is bundled instead, because the runtime's bridge
			// imports the module unconditionally - an absent import would be a
			// build error rather than "no websockets configured".
			// Resolved ONCE, and reported, because this is a silent fork: taking
			// the wrong branch ships a stub and the app boots with a realtime
			// endpoint that denies everything. A relative path resolves against
			// the current working directory - the same base SvelteKit resolves
			// its own `kit.files.*` against - so a build invoked from somewhere
			// other than the project root can miss a handler that is really
			// there. Naming the absolute path checked is what makes that
			// diagnosable instead of mysterious.
			const wsHandlerPath = path.resolve(websocketHandler);
			const hasWsHandler = existsSync(wsHandlerPath);
			if (!hasWsHandler && websocket !== undefined) {
				builder.log.warn(
					`[adapter-bunserve] no WebSocket handler at ${wsHandlerPath}, but \`websocket\` ` +
					'options are configured. The endpoint will be served with no app hooks, so every ' +
					'subscribe is denied SUBSCRIBE_NOT_CONFIGURED. Check the path (it resolves against ' +
					'the current working directory) or pass `websocket.handler` explicitly.'
				);
			}
			if (hasWsHandler) {
				input['ws-handler'] = wsHandlerPath;
			} else {
				writeFileSync(
					`${tmp}/ws-handler.js`,
					'// No WebSocket handler configured. The built-in subscribe/unsubscribe\n' +
					'// demux still runs; this module simply exports no app hooks.\n'
				);
				input['ws-handler'] = `${tmp}/ws-handler.js`;
			}
			if (hasWsHandler) {
				builder.log.minor(`Bundling WebSocket handler ${wsHandlerPath}`);
			}
			for (const warning of wsResult.warnings) {
				builder.log.warn(`[adapter-bunserve] ${warning}`);
			}
			if (wsResult.unknownKeys.length) {
				builder.log.warn(
					`[adapter-bunserve] Unknown \`websocket\` option keys ignored: ${wsResult.unknownKeys.join(', ')}. ` +
					'Check for a typo - an unrecognized key is silently inert at runtime.'
				);
			}

			if (builder.hasServerInstrumentationFile?.()) {
				input['instrumentation.server'] = `${tmp}/instrumentation.server.js`;
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
					// SvelteKit's `$lib` alias. The server bundle produced by
					// writeServer has already had its aliases resolved by Vite,
					// but the WebSocket handler is a project source file rollup
					// reads directly, and `$lib` is ubiquitous in one.
					{
						name: 'adapter-bunserve-kit-alias',
						resolveId(source) {
							if (source === '$lib' || source.startsWith('$lib/')) {
								const libDir = builder.config.kit.files.lib;
								const rest = source === '$lib' ? '' : source.slice('$lib/'.length);
								return this.resolve(path.resolve(libDir, rest), undefined, { skipSelf: true });
							}
							// The project's own `kit.alias` entries. Without these a
							// handler importing through a configured alias resolves to
							// nothing, gets externalized, and fails at BOOT instead of
							// at build.
							for (const [from, to] of Object.entries(builder.config.kit.alias || {})) {
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
						exportConditions: ['bun', 'node']
					}),
					commonjs({ strictRequires: true }),
					json()
				],
				// An import rollup cannot resolve is externalized by default, so
				// the build would report success and the output would fail at
				// boot with a bare unresolved specifier. That is the worst place
				// to find out. `$app/*` and `$env/*` are the realistic cases in a
				// WebSocket handler - there is no esbuild/Vite fallback here, so
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
				const list = unresolvedImports
					.map((u) => `  "${u.source}" imported by ${u.importer}`)
					.join('\n');
				throw new Error(
					`[adapter-bunserve] ${unresolvedImports.length} import(s) could not be resolved:\n${list}\n\n` +
					'These would be left as bare specifiers in the output and crash at startup rather than ' +
					'failing here. The WebSocket handler is bundled straight from project source with no Vite ' +
					"or esbuild pass, so SvelteKit's virtual modules ($app/*, $env/*) are not available to it. " +
					'Read configuration from process.env in the handler, or move the code that needs those ' +
					'modules into a file the SvelteKit server bundle already includes and import it from there.'
				);
			}

			await bundle.write({
				dir: `${out}/server`,
				format: 'esm',
				sourcemap: true,
				chunkFileNames: 'chunks/[name]-[hash].js'
			});

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
					'cache-control, vary, accept-ranges, ...). Every other header is applied.'
				);
			}

			// Dotfiles are excluded from the static index by default, so a
			// dot-path in the output would 404 in production with nothing saying
			// why. Say so here, where the file is still in front of the developer.
			if (!staticDotfiles) {
				const outBase = builder.config.kit.paths.base;
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
					PRECOMPRESS: JSON.stringify(precompress),
					HEALTH_CHECK_PATH: JSON.stringify(healthCheckPath),
					READINESS_CHECK_PATH: JSON.stringify(readinessCheckPath),
					STATIC_HEADERS: JSON.stringify(staticHeadersResult.headers),
					STATIC_CACHE_MAX: JSON.stringify(staticCacheMaxFileSize),
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
					// Measured on the KEYS, not on `websocket !== undefined`.
					// Since `handler` and `path` moved into this block to match
					// svelte-adapter-uws, naming only those is how an app says
					// WHERE the endpoint would be - not that it wants one. An app
					// pointing `handler` at a file it does not have is opting OUT,
					// and reading that as opting in served the endpoint with no
					// hooks, denying every subscribe.
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
							'#ws-handler': './server/ws-handler.js'
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

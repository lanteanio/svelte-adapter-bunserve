/**
 * The adapter's own metrics registry, and the Prometheus document it renders.
 *
 * THE ADAPTER OWNS THE REGISTRY HERE, where svelte-adapter-uws takes one from a
 * module the operator names. That is not a simplification for its own sake - it
 * is what makes a single registry possible at all on this runtime. Measured: a
 * module imported by BOTH a SvelteKit route and the WebSocket handler ends up as
 * two copies in the build, because `writeServer` hands the adapter Vite's
 * already-bundled output (the route's import inlined into a chunk) while the
 * adapter's own bundling pass reads the same file again from source. An app that
 * imported the registry to serve `/metrics` would therefore render a registry
 * the adapter never wrote to. Owning it, and handing it to the app through
 * `platform` - which IS shared with SSR - removes the failure instead of
 * documenting it.
 *
 * The interface is the sibling's `MetricsRegistry` (`counter(name, help,
 * labelNames)`, `gauge(name, help)`, optional `histogram`, optional
 * `serialize()`), so an app that wrote a scrape route against that contract does
 * not care which adapter is underneath, and an app's OWN instruments can be
 * registered on the same registry and land in the same document.
 *
 * Pure: no clock, no timers, no globals, no runtime imports. Every value comes
 * from a caller.
 */

import { SIGNALS, SIGNALS_BY_NAME, SNAPSHOT_SIGNALS } from '../observability-manifest.js';

/**
 * Stable key for a label set. SORTED, so two emits passing the same labels in a
 * different order are one series rather than two.
 *
 * LENGTH-PREFIXED, not separated. A separator - any separator - can be forged
 * out of a label VALUE, and this registry is shared with the app, so the values
 * are not the adapter's to reason about. The sibling keys on a NUL separator
 * and can argue that no adapter-supplied label contains one; here
 * `inc({ a: 'x\0b\0y' })` and `inc({ a: 'x', b: 'y' })` would produce the same
 * key, silently merging two distinct series into one wrong number that nothing
 * downstream could detect. A length prefix is injective for arbitrary strings,
 * which is the property actually needed.
 *
 * @param {Record<string, string> | undefined | null} labels
 * @returns {string}
 */
function labelKey(labels) {
	if (labels === undefined || labels === null) return '';
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	let out = '';
	for (const key of keys) {
		const value = String(labels[key]);
		out += key.length + ':' + key + value.length + ':' + value;
	}
	return out;
}

/**
 * A metric family name, as the exposition format defines one. An app registers
 * on this registry, so a name it chooses reaches the document - and one
 * malformed line makes a parser reject the WHOLE scrape, taking every adapter
 * family with it.
 */
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** A label name, which is the same class minus the colon. */
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Escape a `# HELP` line's text. Only two characters are special there - a
 * backslash and a newline - and an unescaped newline ends the line, leaving the
 * remainder to be parsed as a sample and the document rejected.
 *
 * Label values are escaped separately and by different rules; this is the one
 * an app's `help` string reaches.
 *
 * @param {string} help
 * @returns {string}
 */
function escapeHelp(help) {
	return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * Copy a caller's labels into a plain object, keeping only entries whose NAME
 * the exposition format accepts.
 *
 * A copy, so a caller that mutates the object it passed cannot rewrite a series
 * that is already keyed. A filter, because a label name is not escapable - it is
 * an identifier - so an invalid one can only be dropped or take the whole
 * document down with it. `inc('foo')` is the accident this is really for: a
 * string has indexed own keys, and without the filter it renders as
 * `{0="f",1="o",2="o"}`.
 *
 * @param {unknown} labels
 * @returns {Record<string, string>}
 */
function cleanLabels(labels) {
	/** @type {Record<string, string>} */
	const out = {};
	if (labels === undefined || labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
		return out;
	}
	for (const [name, value] of Object.entries(labels)) {
		if (LABEL_NAME.test(name)) out[name] = String(value);
	}
	return out;
}

/**
 * Render a number in exposition format. Non-finite values are spelled the way
 * Prometheus spells them; ordinary integers avoid exponent notation.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatValue(value) {
	if (Number.isNaN(value)) return 'NaN';
	if (value === Infinity) return '+Inf';
	if (value === -Infinity) return '-Inf';
	return String(value);
}

/**
 * Render a label block, or the empty string when unlabelled. Backslash, quote
 * and newline are escaped - a label value carrying a raw newline would end the
 * sample line and the document would be rejected whole.
 *
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function renderLabels(labels) {
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	const parts = keys.map((key) => {
		const value = String(labels[key])
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n');
		return `${key}="${value}"`;
	});
	return `{${parts.join(',')}}`;
}

/**
 * A metric family's accumulated series.
 *
 * @typedef {{
 *   name: string,
 *   type: 'counter' | 'gauge' | 'histogram',
 *   help: string,
 *   buckets: number[] | null,
 *   series: Map<string, {
 *     labels: Record<string, string>,
 *     value?: number,
 *     histogram?: { counts: number[], count: number, sum: number }
 *   }>
 * }} Family
 */

/**
 * Create a registry.
 *
 * Registration is idempotent by name: asking twice for the same counter hands
 * back an instrument writing into the same family, rather than replacing it and
 * losing what was counted. The adapter registers each of its own signals once,
 * but an app's module can be evaluated more than once in a dev-style reload, and
 * a registry that silently resets its counters on that is worse than one that
 * ignores the second call.
 *
 * @returns {{
 *   counter: (name: string, help?: string, labelNames?: string[]) => { inc: (labels?: any, value?: number) => void },
 *   gauge: (name: string, help?: string) => { set: (value: number) => void },
 *   histogram: (name: string, help?: string, options?: { buckets?: number[] }) => { observe: (labels?: any, value?: number) => void },
 *   projectCounter: (name: string, labels: Record<string, string> | undefined, value: number) => void,
 *   serialize: () => string,
 *   read: () => any[],
 *   reset: () => void
 * }}
 */
export function createMetricRegistry(options = {}) {
	/** @type {Map<string, Family>} */
	const families = new Map();
	/** Names already refused, so one bad instrument warns once rather than per emit. */
	const refused = new Set();

	/**
	 * Say once that a registration was refused. An app's mistake must be visible
	 * - a silently ignored instrument is a dashboard panel that never fills in
	 * with nothing anywhere explaining why - but it must not be repeatable into
	 * a log flood, since the emit that carries it can be per request.
	 *
	 * @param {string} key
	 * @param {string} message
	 */
	function warnOnce(key, message) {
		if (refused.has(key)) return;
		refused.add(key);
		console.warn('[metrics] ' + message);
	}

	/** An instrument that accepts every call and records nothing. */
	const INERT = Object.freeze({
		inc() {}, set() {}, observe() {}
	});

	/**
	 * @param {string} name
	 * @param {'counter' | 'gauge' | 'histogram'} type
	 * @param {string | undefined} help
	 * @param {number[] | null} buckets
	 * @returns {Family | null} null when the registration was refused
	 */
	function family(name, type, help, buckets) {
		const existing = families.get(name);
		if (existing !== undefined) {
			// A NAME IS ONE FAMILY OF ONE TYPE. Asking for a histogram over a name
			// already held by a gauge used to hand back a family with no buckets and
			// throw out of the first `observe`; and a gauge registered over a
			// declared counter used to render `# TYPE ... gauge` under the
			// manifest's reviewed help. Both are refused here instead, because a
			// family cannot be two shapes and the document is where the damage
			// would land.
			if (existing.type !== type) {
				warnOnce(
					'type:' + name,
					`\`${name}\` is already registered as a ${existing.type}; the ${type} registration is ` +
					'ignored. One metric name is one family of one type.'
				);
				return null;
			}
			return existing;
		}
		if (typeof name !== 'string' || !METRIC_NAME.test(name)) {
			warnOnce(
				'name:' + String(name),
				`${JSON.stringify(name)} is not a valid metric name and was ignored. A name must match ` +
				'[a-zA-Z_:][a-zA-Z0-9_:]* - anything else makes the whole scrape unparseable, so one bad ' +
				'instrument would take every other metric with it.'
			);
			return null;
		}
		const declared = SIGNALS_BY_NAME.get(name);
		if (declared !== undefined && declared.type !== type) {
			// The manifest is the contract for a declared name: its TYPE wins as
			// surely as its help does, and a registration that disagrees is refused
			// rather than published under a type an alert rule was not written for.
			warnOnce(
				'declared:' + name,
				`\`${name}\` is declared by this adapter as a ${declared.type}; the ${type} registration ` +
				'is ignored. Pick a name of your own for an instrument of a different type.'
			);
			return null;
		}
		/** @type {Family} */
		const created = {
			name,
			type,
			// The manifest wins over a call-site string for a declared signal, so
			// the help text a scrape sees is the one that was reviewed.
			help: declared !== undefined
				? declared.help
				: escapeHelp(typeof help === 'string' ? help : name),
			buckets,
			series: new Map()
		};
		families.set(name, created);
		return created;
	}

	/**
	 * Resolve a family by NAME on every write rather than closing over the object.
	 *
	 * An instrument that held the object kept writing into a detached family
	 * after `reset()` cleared the map - invisibly, since `serialize()` walks the
	 * map. The adapter holds its gauge instruments for the life of the process,
	 * so one `reset()` from app code silently removed nine live-state gauges from
	 * every later scrape while the counters kept working: a half-dead document
	 * that still looks healthy. One Map lookup per write is the price, on a path
	 * that runs at scrape rate rather than per request.
	 *
	 * @param {string} name
	 * @param {'counter' | 'gauge' | 'histogram'} type
	 * @param {string | undefined} help
	 * @param {number[] | null} buckets
	 * @returns {Family | null}
	 */
	function resolve(name, type, help, buckets) {
		const existing = families.get(name);
		if (existing !== undefined && existing.type === type) return existing;
		return family(name, type, help, buckets);
	}

	/**
	 * Series one family may hold.
	 *
	 * The registry is shared with the app, and the classic way to melt a metrics
	 * system is one label carrying request-derived data - a path, an id, a topic.
	 * Unbounded, that is a leak with no ceiling and a scrape whose cost grows
	 * with it. The adapter's own families are far below this (eleven refusal
	 * reasons, two doors, at most 49 transitions), so the cap can only ever bind
	 * on an app's.
	 */
	const MAX_SERIES_PER_FAMILY = 2000;

	/**
	 * @param {Family} target
	 * @param {Record<string, string> | undefined | null} labels
	 * @param {number} delta
	 * @param {boolean} absolute replace rather than accumulate (a gauge set)
	 */
	function record(target, labels, delta, absolute) {
		const key = labelKey(labels);
		const existing = target.series.get(key);
		if (existing === undefined) {
			if (target.series.size >= MAX_SERIES_PER_FAMILY) {
				warnOnce(
					'cap:' + target.name,
					`\`${target.name}\` reached ${MAX_SERIES_PER_FAMILY} label combinations; further ones ` +
					'are dropped. A label carrying request-derived data (a path, an id) is the usual ' +
					'cause - the series would otherwise grow without limit and every scrape with them.'
				);
				return;
			}
			target.series.set(key, {
				labels: cleanLabels(labels),
				value: delta
			});
			return;
		}
		existing.value = absolute ? delta : (existing.value ?? 0) + delta;
	}

	return {
		counter(name, help) {
			if (family(name, 'counter', help, null) === null) return INERT;
			return {
				inc(labels, value) {
					const target = resolve(name, 'counter', help, null);
					if (target === null) return;
					// A non-number `value` is 1, not NaN: the contract says value
					// defaults to 1, and a caller passing something unusable must not
					// be able to poison a series into unreadability for the life of
					// the process. Bulk increments (a counter reporting frames rather
					// than incidents) need the number honoured, so it is honoured.
					const delta = typeof value === 'number' && Number.isFinite(value) ? value : 1;
					// Negative would make a counter go backwards, which Prometheus
					// reads as a reset and charges as a full re-count.
					if (delta < 0) return;
					record(target, labels, delta, false);
				}
			};
		},
		gauge(name, help) {
			if (family(name, 'gauge', help, null) === null) return INERT;
			return {
				set(value) {
					const target = resolve(name, 'gauge', help, null);
					if (target === null || typeof value !== 'number') return;
					record(target, undefined, value, true);
				}
			};
		},
		histogram(name, help, options) {
			// VALIDATED at registration, not at observe: a bound is written once and
			// read on every scrape, so a bound that is not a finite number renders
			// into the `le` label and makes the document unparseable long after the
			// call site that supplied it is out of sight. Duplicates are dropped for
			// the same reason - two identical `le` lines are two series with one
			// name.
			const requested = Array.isArray(options?.buckets) && options.buckets.length > 0
				? options.buckets
				: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
			const buckets = [...new Set(requested.filter((bound) => typeof bound === 'number' && Number.isFinite(bound)))]
				.sort((a, b) => a - b);
			if (buckets.length !== requested.length) {
				warnOnce(
					'buckets:' + name,
					`\`${name}\` was given bucket bounds that are not finite numbers, or duplicates; ` +
					`${requested.length - buckets.length} were dropped. A bound reaches the \`le\` label ` +
					'verbatim, and one that is not a number makes the whole scrape unparseable.'
				);
			}
			if (buckets.length === 0 || family(name, 'histogram', help, buckets) === null) return INERT;
			return {
				observe(labels, value) {
					const target = resolve(name, 'histogram', help, buckets);
					if (target === null) return;
					// `observe(value)` and `observe(labels, value)` are both in the
					// wild, and the one-argument form is the common one for an
					// unlabelled histogram.
					const observed = typeof labels === 'number' && value === undefined ? labels : value;
					const observedLabels = typeof labels === 'number' && value === undefined ? undefined : labels;
					if (typeof observed !== 'number' || !Number.isFinite(observed)) return;
					// REFUSED, rather than recorded into a sum that then goes
					// backwards. A decreasing `_sum` reads as a counter reset to
					// everything downstream, and the sibling's merge drops any
					// histogram whose sum is negative outright - so a document with one
					// in it is one the family cannot agree on.
					if (observed < 0) return;
					const bounds = /** @type {number[]} */ (target.buckets);
					const key = labelKey(observedLabels);
					let entry = target.series.get(key);
					if (entry === undefined || entry.histogram === undefined) {
						if (target.series.size >= MAX_SERIES_PER_FAMILY) return;
						entry = {
							labels: cleanLabels(observedLabels),
							histogram: { counts: new Array(bounds.length).fill(0), count: 0, sum: 0 }
						};
						target.series.set(key, entry);
					}
					const histogram = /** @type {{ counts: number[], count: number, sum: number }} */ (entry.histogram);
					for (let i = 0; i < bounds.length; i++) {
						if (observed <= bounds[i]) histogram.counts[i]++;
					}
					histogram.count++;
					histogram.sum += observed;
				}
			};
		},

		/**
		 * Publish an ABSOLUTE value for a counter family whose authoritative
		 * source is elsewhere in the runtime.
		 *
		 * This is how the adapter's own counters get here, and it is the whole
		 * reason the emit sites the sibling has do not exist in this adapter. The
		 * runtime already counts refusals, publishes and closed-socket aborts in
		 * `wsCounters`; incrementing a second, parallel set of instruments at
		 * those call sites would put a metrics write on hot paths and create two
		 * numbers that can disagree. Projecting the authoritative one at read time
		 * costs nothing until something scrapes, and cannot drift.
		 *
		 * The value is written as given rather than clamped to be non-decreasing.
		 * In a build the sources are monotonic for the life of the process, so a
		 * decrease can only come from a harness resetting them - and freezing the
		 * metric at the old value there would hide the reset rather than show it.
		 *
		 * @param {string} name
		 * @param {Record<string, string> | undefined} labels
		 * @param {number} value
		 */
		projectCounter(name, labels, value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return;
			const target = resolve(name, 'counter', undefined, null);
			if (target === null) return;
			record(target, labels, value, true);
		},

		/**
		 * Retract a family so the next document omits it entirely.
		 *
		 * The counterpart to a projection that can stop being measurable. A gauge
		 * whose source has gone away cannot be answered with a zero (that is a
		 * measurement, and a false one) and cannot be left at its last value
		 * either - a frozen reading published as current is the worse of the two,
		 * because it looks alive. Retracting is the third answer: the family
		 * disappears until something measures it again, which is what a scraper
		 * reads as "this instance no longer reports this".
		 *
		 * Registration-state only, so re-registering later is a fresh family. Not
		 * for app instruments: an app that stops writing to a counter still wants
		 * its last total.
		 *
		 * @param {string} name
		 * @returns {boolean} whether a family was there to retract
		 */
		retract(name) {
			return families.delete(name);
		},

		/**
		 * The whole document, in Prometheus text exposition format.
		 *
		 * MANIFEST ORDER FIRST, so two scrapes of an unchanged server are
		 * byte-identical and a diff between two scrapes is readable. Families the
		 * app registered follow in registration order - they are not the adapter's
		 * to order, and registration order is at least the app's own.
		 *
		 * A declared family that has never been touched is rendered as a zero when
		 * it carries no labels, and omitted when it does: an unlabelled counter has
		 * exactly one knowable zero series, while a labelled family has no label
		 * values until its first event and inventing one would publish a series
		 * that never goes away.
		 */
		serialize() {
			// The projection runs FIRST when one is installed, so a caller that
			// serializes the registry directly - `platform.metrics` is a documented
			// member and this is the registry it hands back - gets the same document
			// the adapter's own snapshot returns, rather than one whose adapter
			// families are whatever the last scrape left behind.
			if (typeof options.beforeSerialize === 'function') options.beforeSerialize();
			/** @type {string[]} */
			const out = [];
			/** @type {Set<string>} */
			const rendered = new Set();

			for (const signal of SIGNALS) {
				rendered.add(signal.name);
				const snapshotValue = /** @type {Record<string, number>} */ (SNAPSHOT_SIGNALS)[signal.name];
				if (snapshotValue !== undefined) {
					out.push(`# HELP ${signal.name} ${signal.help}`);
					out.push(`# TYPE ${signal.name} ${signal.type}`);
					out.push(`${signal.name} ${formatValue(snapshotValue)}`);
					continue;
				}
				const target = families.get(signal.name);
				if (target === undefined) {
					// Never registered. Nothing is known about it, not even a zero -
					// this is the "absent rather than zero" rule the manifest states.
					continue;
				}
				renderFamily(out, target);
			}

			for (const [name, target] of families) {
				if (rendered.has(name)) continue;
				renderFamily(out, target);
			}

			return out.length === 0 ? '' : out.join('\n') + '\n';
		},

		/**
		 * The registry's values, structured. Not the scrape format - this is what
		 * a test reads, and what a future cluster collection would carry.
		 */
		read() {
			/** @type {any[]} */
			const out = [];
			for (const target of families.values()) {
				for (const entry of target.series.values()) {
					if (entry.histogram !== undefined) {
						out.push({
							name: target.name,
							labels: { ...entry.labels },
							histogram: {
								buckets: /** @type {number[]} */ (target.buckets).slice(),
								counts: entry.histogram.counts.slice(),
								count: entry.histogram.count,
								sum: entry.histogram.sum
							}
						});
					} else {
						out.push({ name: target.name, labels: { ...entry.labels }, value: entry.value });
					}
				}
			}
			return out;
		},

		/** Drop everything. For tests and for a harness that rebuilds a server. */
		reset() {
			families.clear();
		}
	};
}

/**
 * @param {string[]} out
 * @param {Family} target
 */
function renderFamily(out, target) {
	if (target.series.size === 0) {
		// A registered family with no samples. Only the unlabelled case has a
		// knowable zero series; see serialize()'s note.
		const declared = SIGNALS_BY_NAME.get(target.name);
		if (declared !== undefined && declared.labels.length > 0) return;
		if (target.type === 'histogram') return;
		out.push(`# HELP ${target.name} ${target.help}`);
		out.push(`# TYPE ${target.name} ${target.type}`);
		out.push(`${target.name} 0`);
		return;
	}
	out.push(`# HELP ${target.name} ${target.help}`);
	out.push(`# TYPE ${target.name} ${target.type}`);
	// Sorted by the RENDERED label block, not by the internal key: the key is
	// length-prefixed so that it cannot be forged, which makes its sort order an
	// artefact of value lengths rather than anything a reader would recognise.
	// Sorting on what the document actually shows is what makes two scrapes
	// diffable by eye.
	const ordered = [...target.series.entries()]
		.map(([key, entry]) => ({ key, entry, rendered: renderLabels(entry.labels) }))
		.sort((a, b) => (a.rendered < b.rendered ? -1 : a.rendered > b.rendered ? 1 : 0));
	for (const { key } of ordered) {
		const entry = /** @type {{ labels: Record<string, string>, value?: number, histogram?: any }} */ (
			target.series.get(key)
		);
		if (entry.histogram !== undefined) {
			const bounds = /** @type {number[]} */ (target.buckets);
			for (let i = 0; i < bounds.length; i++) {
				out.push(
					`${target.name}_bucket${renderLabels({ ...entry.labels, le: formatValue(bounds[i]) })} ` +
					`${formatValue(entry.histogram.counts[i])}`
				);
			}
			out.push(
				`${target.name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ` +
				`${formatValue(entry.histogram.count)}`
			);
			out.push(`${target.name}_sum${renderLabels(entry.labels)} ${formatValue(entry.histogram.sum)}`);
			out.push(`${target.name}_count${renderLabels(entry.labels)} ${formatValue(entry.histogram.count)}`);
			continue;
		}
		out.push(`${target.name}${renderLabels(entry.labels)} ${formatValue(entry.value ?? 0)}`);
	}
}

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
 * Separator for the label-set key.
 *
 * A label VALUE is arbitrary text, so a printable separator can be forged:
 * `{a: 'x,b', c: 'y'}` and `{a: 'x', 'b,c': 'y'}` would key alike and two
 * distinct series would silently merge into one wrong number. NUL cannot occur
 * in a label any caller can supply.
 *
 * Built from a char code rather than written literally, for the reason the
 * sibling gives: a raw NUL byte in the source makes the whole file binary to
 * git, and a file that cannot be diffed cannot be reviewed.
 */
const LABEL_SEP = String.fromCharCode(0);

/**
 * Stable key for a label set. SORTED, so two emits passing the same labels in a
 * different order are one series rather than two.
 *
 * @param {Record<string, string> | undefined | null} labels
 * @returns {string}
 */
function labelKey(labels) {
	if (labels === undefined || labels === null) return '';
	const keys = Object.keys(labels).sort();
	if (keys.length === 0) return '';
	let out = '';
	for (const key of keys) out += key + LABEL_SEP + String(labels[key]) + LABEL_SEP;
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
export function createMetricRegistry() {
	/** @type {Map<string, Family>} */
	const families = new Map();

	/**
	 * @param {string} name
	 * @param {'counter' | 'gauge' | 'histogram'} type
	 * @param {string | undefined} help
	 * @param {number[] | null} buckets
	 * @returns {Family}
	 */
	function family(name, type, help, buckets) {
		const existing = families.get(name);
		if (existing !== undefined) return existing;
		const declared = SIGNALS_BY_NAME.get(name);
		/** @type {Family} */
		const created = {
			name,
			type,
			// The manifest wins over a call-site string for a declared signal, so
			// the help text a scrape sees is the one that was reviewed.
			help: declared !== undefined ? declared.help : (typeof help === 'string' ? help : name),
			buckets: buckets === null ? null : [...buckets].sort((a, b) => a - b),
			series: new Map()
		};
		families.set(name, created);
		return created;
	}

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
			target.series.set(key, {
				labels: labels === undefined || labels === null ? {} : { ...labels },
				value: delta
			});
			return;
		}
		existing.value = absolute ? delta : (existing.value ?? 0) + delta;
	}

	return {
		counter(name, help) {
			const target = family(name, 'counter', help, null);
			return {
				inc(labels, value) {
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
			const target = family(name, 'gauge', help, null);
			return {
				set(value) {
					if (typeof value !== 'number') return;
					record(target, undefined, value, true);
				}
			};
		},
		histogram(name, help, options) {
			const buckets = Array.isArray(options?.buckets) && options.buckets.length > 0
				? options.buckets
				: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
			const target = family(name, 'histogram', help, buckets);
			return {
				observe(labels, value) {
					// `observe(value)` and `observe(labels, value)` are both in the
					// wild, and the one-argument form is the common one for an
					// unlabelled histogram.
					const observed = typeof labels === 'number' && value === undefined ? labels : value;
					const observedLabels = typeof labels === 'number' && value === undefined ? undefined : labels;
					if (typeof observed !== 'number' || !Number.isFinite(observed)) return;
					const bounds = /** @type {number[]} */ (target.buckets);
					const key = labelKey(observedLabels);
					let entry = target.series.get(key);
					if (entry === undefined || entry.histogram === undefined) {
						entry = {
							labels: observedLabels === undefined || observedLabels === null
								? {}
								: { ...observedLabels },
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
			record(family(name, 'counter', undefined, null), labels, value, true);
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
							labels: entry.labels,
							histogram: {
								buckets: /** @type {number[]} */ (target.buckets).slice(),
								counts: entry.histogram.counts.slice(),
								count: entry.histogram.count,
								sum: entry.histogram.sum
							}
						});
					} else {
						out.push({ name: target.name, labels: entry.labels, value: entry.value });
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
	// Sorted by label key, so a family with several label sets renders in a
	// stable order across scrapes rather than in insertion order.
	for (const key of [...target.series.keys()].sort()) {
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

// The metrics OUTPUT contract, from the harness.
//
// `createTestServer` always accepted a registry as an INPUT and registered its
// own instruments against it. What it did not do was hand that registry back as
// `platform.metrics`, or answer `platform.metricsSnapshot()` - both of which
// exist only in the built production runtime. So the one route the README leads
// with, a `/metrics` endpoint reading `platform.metrics`, was the one route that
// could not be exercised anywhere but a production build: a test for it had to
// be written against a different surface than the code it was testing.
//
// These cases drive the harness platform the way an app route would.

import { describe, it, expect, afterEach } from 'bun:test';

/** @type {any} */
let server = null;

afterEach(async () => {
	try { await server?.close?.(); } catch { /* already down */ }
	server = null;
});

/** A registry of the documented shape: it accepts instrument calls and records them. */
function recordingRegistry() {
	/** @type {Array<{ kind: string, name: string }>} */
	const created = [];
	const make = (kind) => (name) => {
		created.push({ kind, name });
		return { inc() {}, set() {}, observe() {} };
	};
	return { created, counter: make('counter'), gauge: make('gauge'), histogram: make('histogram') };
}

describe('the harness exposes the metrics members a route reads', () => {
	it('hands back the registry it was given', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		const registry = recordingRegistry();
		server = await createTestServer({ metrics: registry, handler: {} });

		const platform = server.platform ?? server.app?.platform ?? null;
		expect(platform, 'the harness must expose a platform to read this from').toBeTruthy();
		expect(platform.metrics, 'a route reading platform.metrics must find the registry').toBe(registry);
		// It really is the live one: the harness registered against it.
		expect(registry.created.length, 'the harness registers its own instruments').toBeGreaterThan(0);
	});

	it('answers null for metrics when none was supplied, as production does', async () => {
		const { createTestServer } = await import('../../src/testing.js');
		server = await createTestServer({ handler: {} });
		const platform = server.platform ?? server.app?.platform ?? null;
		expect(platform.metrics).toBeNull();
		await expect(platform.metricsSnapshot()).resolves.toBeNull();
	});

	it('produces a merged snapshot document, not the registry own rendering', async () => {
		// The snapshot is built from the mirror, so it works with a registry that
		// renders nothing back - which the documented shape does not oblige it to
		// do. A snapshot that asked the registry to serialize would fail here.
		const { createTestServer } = await import('../../src/testing.js');
		server = await createTestServer({ metrics: recordingRegistry(), handler: {} });
		const platform = server.platform ?? server.app?.platform ?? null;

		const body = await platform.metricsSnapshot();
		expect(typeof body, 'a supplied registry must produce a document').toBe('string');

		// And it must contain the harness's OWN instruments, not merely be
		// non-empty. That is the whole reason the registry is wrapped: the
		// snapshot is collected from the metric mirror, and building instruments
		// straight from the caller's registry leaves the mirror empty. Asserting
		// only "a non-empty string" passes either way - measured, the document is
		// 890 characters with the wrapping and 552 without, and this series is
		// exactly what the difference is made of.
		expect(
			body,
			'the snapshot must carry the instruments this server registered'
		).toContain('upgrade_deferred_depth');
	});

	it('keeps an app series out of the snapshot: the manifest filter, pinned directly', async () => {
		// The documented law: the snapshot covers the adapter's own metrics and
		// never an app's - the adapter cannot know whether an app series should
		// be summed, maxed or averaged across workers, and guessing would be a
		// silent wrong number. The law is enforced STRUCTURALLY: mergeSamples
		// renders only names the signal manifest declares and drops every other
		// sample. That filter is pinned here at the merge itself, because an
		// end-to-end "snapshot does not contain my series" assertion cannot
		// fail - no surface feeds an app name into the mirror in the first
		// place - and a pin that cannot fail pins nothing. The declared name
		// beside it is the positive control: the same input shape renders when
		// the manifest knows it.
		const { mergeSamples } = await import('../../src/runtime/utils/metrics-merge.js');
		const doc = mergeSamples([{
			worker: 0,
			samples: [
				{ name: 'app_requests_total', labels: {}, value: 7 },
				{ name: 'ws_connections', labels: {}, value: 3 }
			]
		}], { expected: 1, degraded: false });
		expect(doc, 'a manifest-declared sample renders').toContain('ws_connections 3');
		expect(doc, 'an undeclared sample is dropped rather than guessed at').not.toContain('app_requests_total');

		// And the half the app relies on instead: an instrument created through
		// platform.metrics lands on the LIVE registry, where the documented
		// scrape route reads it.
		const { createTestServer } = await import('../../src/testing.js');
		const registry = recordingRegistry();
		server = await createTestServer({ metrics: registry, handler: {} });
		const platform = server.platform ?? server.app?.platform ?? null;
		platform.metrics.counter('app_requests_total').inc();
		expect(
			registry.created.some((c) => c.name === 'app_requests_total'),
			'the object handed back is the live registry, so the instrument lands on it'
		).toBe(true);
	});
});

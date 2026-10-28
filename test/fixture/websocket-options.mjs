// Shared by the fixture build and leak workload pacing.
export const websocketOptions = {
	metrics: './src/metrics.js',
	// The harness drives many clients from one address. The rate-limit suite
	// has a separate build; leak churn derives its pacing from this setting.
	upgradeRateLimit: 0,
	// Exercise serialization of a non-default pressure block and allow the
	// live pressure suite to observe several samples without long sleeps.
	pressure: { sampleIntervalMs: 200 }
};

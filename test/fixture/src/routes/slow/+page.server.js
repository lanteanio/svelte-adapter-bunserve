// Slow render: makes concurrent anonymous GETs genuinely overlap so the SSR
// dedup leader/waiter path is observable (all overlapping requests must get
// the leader's render, i.e. the same random value).
export async function load() {
	await new Promise((r) => setTimeout(r, 150));
	return { n: Math.random() };
}

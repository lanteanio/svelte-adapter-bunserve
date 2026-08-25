// Echo of the client identity the adapter resolved for this request, for the
// live checks that drive the forwarded-header parsing over a real socket. The
// resolution throws when XFF_DEPTH names a hop the chain does not carry, so
// the throw is caught into the body: the check asserts on WHAT failed, and a
// bare 500 would leave it guessing.
export function GET({ getClientAddress }) {
	let address = null;
	let error = null;
	try {
		address = getClientAddress();
	} catch (err) {
		error = String(err instanceof Error ? err.message : err);
	}
	return new Response(JSON.stringify({ address, error }), {
		headers: { 'content-type': 'application/json' }
	});
}

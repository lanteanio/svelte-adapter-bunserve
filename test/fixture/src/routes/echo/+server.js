export async function POST({ request }) {
	const body = await request.arrayBuffer();
	return new Response(JSON.stringify({ bytes: body.byteLength }), {
		headers: { 'content-type': 'application/json' }
	});
}

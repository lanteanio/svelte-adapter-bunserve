export function GET() {
	const headers = new Headers({ 'content-type': 'application/json' });
	headers.append('set-cookie', 'first=1; Path=/; HttpOnly');
	headers.append('set-cookie', 'second=2; Path=/; SameSite=Lax');
	return new Response(JSON.stringify({ cookies: 2 }), { headers });
}

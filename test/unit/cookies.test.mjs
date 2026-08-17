import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCookies, parseCookies, serializeCookie } from '../../src/runtime/utils/cookies.js';

// The cookie jar the auth preflight hook is handed. Everything here is a
// property the sibling adapter has too - the module is a verified port, and a
// difference in any of these is a cookie that reaches the browser with a
// different scope depending on which adapter served the app.

// - parseCookies --------------------------------------------------------------

test('a Cookie header becomes a name/value bag', () => {
	assert.deepEqual({ ...parseCookies('sid=abc; theme=dark') }, { sid: 'abc', theme: 'dark' });
	assert.deepEqual({ ...parseCookies('') }, {});
	assert.deepEqual({ ...parseCookies(undefined) }, {});
	assert.deepEqual({ ...parseCookies(null) }, {});
});

test('the bag has no prototype', () => {
	// A request carrying `__proto__=evil` would otherwise write through the
	// inherited setter of an ordinary object, and every later lookup in the
	// process could read an attacker's value.
	const bag = parseCookies('__proto__=evil; toString=1');
	assert.equal(Object.getPrototypeOf(bag), null);
	assert.equal(bag.__proto__, 'evil', 'stored as an ordinary own key');
	assert.equal(Object.getPrototypeOf({}), Object.prototype, 'and nothing global moved');
});

test('a quoted value is unquoted, and a pair with no `=` is skipped', () => {
	assert.equal(parseCookies('theme="dark"').theme, 'dark');
	assert.deepEqual({ ...parseCookies('a=1; b; c=3') }, { a: '1', c: '3' });
});

test('a percent-encoded value is decoded, and an undecodable one is kept', () => {
	assert.equal(parseCookies('a=%41').a, 'A');
	// `decodeURIComponent` throws on a lone `%`. A cookie some other service
	// wrote is not this adapter's to discard.
	assert.equal(parseCookies('a=%').a, '%');
});

// - serializeCookie -----------------------------------------------------------

test('attributes are written in the order a Set-Cookie line expects them', () => {
	assert.equal(
		serializeCookie('sid', 'abc', { path: '/', domain: 'app.example', httpOnly: true, secure: true, sameSite: 'lax' }),
		'sid=abc; Domain=app.example; Path=/; HttpOnly; Secure; SameSite=Lax'
	);
});

test('the value is percent-encoded unless the caller opts out', () => {
	assert.equal(serializeCookie('a', 'x y'), 'a=x%20y');
	assert.equal(serializeCookie('a', 'x-y', { encode: false }), 'a=x-y');
});

test('a control character is refused in a name, a value, and an attribute', () => {
	// This is the injection the character classes exist for: a CR or LF that
	// survives into the header splits the response, and a `;` opens an attribute
	// the caller never wrote. An app that builds a cookie out of client input
	// reaches all three.
	assert.throws(() => serializeCookie('a\x0db', 'x'), /Invalid cookie name/);
	assert.throws(() => serializeCookie('a\x00b', 'x'), /Invalid cookie name/);
	assert.throws(() => serializeCookie('a;b', 'x'), /Invalid cookie name/);
	assert.throws(() => serializeCookie('a', 'x\x0ay', { encode: false }), /Invalid cookie value/);
	assert.throws(() => serializeCookie('a', 'x;y', { encode: false }), /Invalid cookie value/);
	assert.throws(() => serializeCookie('a', 'x', { path: '/a\x0db' }), /Invalid Path/);
	assert.throws(() => serializeCookie('a', 'x', { domain: 'a b' }), /Invalid Domain/);
	// Encoding is what makes the ordinary path safe: the same bytes go through
	// when the caller has not opted out of it.
	assert.equal(serializeCookie('a', 'x\x0ay'), 'a=x%0Ay');
});

test('Max-Age is floored, and a non-finite one is refused', () => {
	assert.match(serializeCookie('a', 'x', { maxAge: 1.7 }), /Max-Age=1$/);
	assert.throws(() => serializeCookie('a', 'x', { maxAge: NaN }), /Invalid Max-Age/);
	assert.throws(() => serializeCookie('a', 'x', { maxAge: Infinity }), /Invalid Max-Age/);
});

test('SameSite is normalized, `true` means strict, and `false` omits it', () => {
	assert.match(serializeCookie('a', 'x', { sameSite: 'NONE' }), /SameSite=None$/);
	assert.match(serializeCookie('a', 'x', { sameSite: true }), /SameSite=Strict$/);
	assert.equal(serializeCookie('a', 'x', { sameSite: false }), 'a=x');
	assert.throws(() => serializeCookie('a', 'x', { sameSite: 'sometimes' }), /Invalid SameSite/);
});

// - createCookies -------------------------------------------------------------

test('the request URL is required, because the Secure default comes from it', () => {
	// A defaulted argument would be fail-open: a caller that forgot it would
	// quietly write session cookies without Secure.
	assert.throws(() => createCookies('a=1', ''), /requires the request URL/);
	assert.throws(() => createCookies('a=1', undefined), /requires the request URL/);
});

test('Secure defaults on, except on plain-http localhost', () => {
	const secure = createCookies('', 'https://app.example/x');
	secure.set('sid', 'abc', { path: '/' });
	assert.match(secure._serialize()[0], /; Secure/);

	const local = createCookies('', 'http://localhost:5173/x');
	local.set('sid', 'abc', { path: '/' });
	assert.doesNotMatch(local._serialize()[0], /; Secure/);

	// Not the same thing as localhost: a browser treats 127.0.0.1 as a secure
	// context, but the cookie still has to be sent over http, so the default
	// follows the sibling rather than being widened here.
	const loopback = createCookies('', 'http://127.0.0.1:5173/x');
	loopback.set('sid', 'abc', { path: '/' });
	assert.match(loopback._serialize()[0], /; Secure/);
});

test('HttpOnly and SameSite=Lax are the defaults, and the caller can override them', () => {
	const jar = createCookies('', 'https://app.example/x');
	jar.set('sid', 'abc', { path: '/' });
	assert.equal(jar._serialize()[0], 'sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax');
	jar.set('open', 'v', { path: '/', httpOnly: false, sameSite: 'none' });
	assert.equal(jar._serialize()[1], 'open=v; Path=/; Secure; SameSite=None');
});

test('a path must be given, on set and on delete alike', () => {
	const jar = createCookies('', 'https://app.example/x');
	assert.throws(() => jar.set('sid', 'abc', {}), /must specify a `path`/);
	assert.throws(() => jar.set('sid', 'abc'), /must specify a `path`/);
	assert.throws(() => jar.delete('sid', {}), /must specify a `path`/);
});

test('a relative path is resolved against the request URL', () => {
	// Without this, `Path=sub` reaches the browser, which discards it for the
	// RFC 6265 default path - a silent scope change from what was asked for.
	const jar = createCookies('', 'https://app.example/a/b');
	jar.set('sid', 'abc', { path: 'sub' });
	assert.match(jar._serialize()[0], /; Path=\/a\/sub;/);
});

test('two sets of the same name, path and domain are one cookie; a different scope is another', () => {
	const jar = createCookies('', 'https://app.example/x');
	jar.set('sid', 'one', { path: '/' });
	jar.set('sid', 'two', { path: '/' });
	assert.equal(jar._serialize().length, 1);
	assert.match(jar._serialize()[0], /^sid=two;/);

	jar.set('sid', 'three', { path: '/admin' });
	assert.equal(jar._serialize().length, 2, 'a different path is a different cookie to a browser');
});

test('a set is readable back in the same hook', () => {
	const jar = createCookies('sid=old', 'https://app.example/x');
	assert.equal(jar.get('sid'), 'old');
	jar.set('sid', 'new', { path: '/' });
	assert.equal(jar.get('sid'), 'new');
	assert.deepEqual(jar.getAll(), { sid: 'new' });
});

test('a delete expires the cookie at the epoch and takes it out of the jar', () => {
	const jar = createCookies('sid=old', 'https://app.example/x');
	jar.delete('sid', { path: '/' });
	const line = jar._serialize()[0];
	assert.match(line, /^sid=;/);
	assert.match(line, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
	assert.match(line, /Max-Age=0/);
	assert.equal(jar.get('sid'), undefined);
});

test('getAll hands back a copy, not the jar', () => {
	const jar = createCookies('sid=old', 'https://app.example/x');
	const all = jar.getAll();
	all.sid = 'tampered';
	assert.equal(jar.get('sid'), 'old');
	assert.equal(Object.getPrototypeOf(all), Object.prototype, 'and an ordinary object to spread');
});

export function detectSetCookieOnUpgrade(source) {
	// Scan each upgradeResponse( call for a 'set-cookie' / "Set-Cookie" literal
	// inside its arguments. Works against bundler output (esbuild/rollup/Vite),
	// which preserves these as literals even after minification rewrites the
	// surrounding identifiers.
	const re = /upgradeResponse\s*\(/gi;
	let match;
	while ((match = re.exec(source)) !== null) {
		// Walk forward matching parens to find the end of the call
		let depth = 1;
		let i = match.index + match[0].length;
		let inStr = '';
		let esc = false;
		for (; i < source.length && depth > 0; i++) {
			const c = source[i];
			if (esc) { esc = false; continue; }
			if (inStr) {
				if (c === '\\') esc = true;
				else if (c === inStr) inStr = '';
				continue;
			}
			if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
			if (c === '(') depth++;
			else if (c === ')') depth--;
		}
		const args = source.slice(match.index + match[0].length, i - 1);
		if (/['"`]\s*set-cookie\s*['"`]/i.test(args)) return true;
	}
	return false;
}

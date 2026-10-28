import { existsSync } from 'node:fs';
import path from 'node:path';

export function discoverHandler(root, explicit, aliases = []) {
	if (explicit) return resolveHandler(root, explicit, aliases);
	for (const file of ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs']) {
		const resolved = path.resolve(root, file);
		if (existsSync(resolved)) return resolved;
	}
	return null;
}

export function resolveHandler(root, name, aliases = []) {
	const entries = Array.isArray(aliases) ? aliases : Object.entries(aliases).map(([find, replacement]) => {
		if (find.endsWith('/*')) {
			const prefix = find.slice(0, -1);
			return { find: new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.+)$'), replacement: replacement.replace(/\/\*$/, '') + '/$1' };
		}
		if (find + '/*' in aliases) return { find: new RegExp('^' + find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: replacement.replace(/\/\*$/, '') };
		return { find, replacement: replacement.replace(/\/\*$/, '') };
	});
	for (const { find, replacement } of entries) {
		if (typeof find === 'string' && (name === find || name.startsWith(find + '/'))) {
			return path.resolve(root, replacement + name.slice(find.length));
		}
		if (find instanceof RegExp) {
			const pattern = new RegExp(find.source, find.flags);
			if (pattern.test(name)) {
				pattern.lastIndex = 0;
				return path.resolve(root, name.replace(pattern, replacement));
			}
		}
	}
	return path.resolve(root, name);
}

export function legacyHandlerWarning(root, explicit) {
	return !explicit && !discoverHandler(root) && existsSync(path.resolve(root, 'src/ws-handler.js'))
		? 'src/ws-handler.js is no longer discovered and WebSockets are now opt-in. Rename it to src/hooks.ws.js and enable websocket: true, or set websocket.handler explicitly.'
		: null;
}

export function assertHandlerExists(full, named, where) {
	// Other forms may resolve through a Vite alias or virtual-module plugin.
	if (!(named.startsWith('./') || named.startsWith('../')) || existsSync(full)) return;
	throw new Error(`[adapter-bunserve] WebSocket handler ${JSON.stringify(named)} (${where}) does not exist.\n  looked for: ${full}`);
}

export function sameHandler(a, b) {
	return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

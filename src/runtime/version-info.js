/**
 * Runtime version identity: this adapter's own version, the protocol revision
 * it implements, and the RESOLVED versions of the family siblings installed
 * next to the app. Everything is read from files at runtime - the build
 * copies the exact package.json and protocol.schema.json that produced the
 * server into <out>/meta - never from constants inlined into the bundle, so
 * what the banner reports is what is actually deployed.
 *
 * Why this exists: a three-package family with a frozen protocol revision is
 * exactly the topology where partial upgrades and registry cooldowns produce
 * confusing bug reports. When two surfaces disagree, compare these versions
 * first; the banner puts the answer at the top of every boot log.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read a metadata file from the build output (`meta/` next to this module),
 * falling back to the repository copies for a source checkout (tests, dev).
 *
 * @param {string} name
 * @returns {string | null}
 */
function readMeta(name) {
	for (const p of [path.join(HERE, 'meta', name), path.join(HERE, '..', '..', name)]) {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			// Try the next location; a missing file is answered by the caller.
		}
	}
	return null;
}

/**
 * The protocol revision a schema document declares, from its `$id`
 * (`urn:lantean-protocol:revision-N`), with the `title` ("... revision N") as
 * the fallback. Null when the text is not a schema that declares one - the
 * banner then says "unknown" rather than inventing a number.
 *
 * @param {string} schemaText
 * @returns {number | null}
 */
export function parseProtocolRevision(schemaText) {
	try {
		const schema = JSON.parse(schemaText);
		const id = typeof schema.$id === 'string' ? schema.$id : '';
		let m = /revision-(\d+)$/.exec(id);
		if (m) return Number(m[1]);
		const title = typeof schema.title === 'string' ? schema.title : '';
		m = /revision (\d+)/i.exec(title);
		if (m) return Number(m[1]);
	} catch {
		// Not JSON: fall through to null.
	}
	return null;
}

/**
 * The version of a sibling package as it actually RESOLVES from here, or null
 * when it is not installed. import.meta.resolve answers with the real file
 * the app would load - which is the point: the peer-dependency ranges say
 * what is allowed, this says what is present.
 *
 * @param {string} specifier - an export subpath that exists in the sibling
 * @param {string} packageName - the package whose own manifest must answer,
 *   so a nested resolution can never read some other package's version
 * @returns {string | null}
 */
function siblingVersion(specifier, packageName) {
	let url;
	try {
		url = import.meta.resolve(specifier);
	} catch {
		return null;
	}
	let dir;
	try {
		dir = path.dirname(fileURLToPath(url));
	} catch {
		return null;
	}
	for (let i = 0; i < 10; i++) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
			if (pkg.name === packageName) {
				return typeof pkg.version === 'string' ? pkg.version : null;
			}
		} catch {
			// No manifest at this level; keep walking up.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * @returns {{
 *   name: string,
 *   version: string | null,
 *   protocolRevision: number | null,
 *   siblings: Record<string, string | null>
 * }}
 */
export function versionInfo() {
	let name = 'svelte-adapter-bunserve';
	let version = null;
	const pkgText = readMeta('package.json');
	if (pkgText) {
		try {
			const pkg = JSON.parse(pkgText);
			if (typeof pkg.name === 'string') name = pkg.name;
			if (typeof pkg.version === 'string') version = pkg.version;
		} catch {
			// A corrupt manifest downgrades the banner, never the boot.
		}
	}
	const schemaText = readMeta('protocol.schema.json');
	return {
		name,
		version,
		protocolRevision: schemaText === null ? null : parseProtocolRevision(schemaText),
		siblings: {
			'svelte-realtime': siblingVersion('svelte-realtime', 'svelte-realtime'),
			// The extensions package exports no root subpath; /testing is a
			// published entry every install has.
			'svelte-adapter-uws-extensions': siblingVersion(
				'svelte-adapter-uws-extensions/testing',
				'svelte-adapter-uws-extensions'
			)
		}
	};
}

/**
 * One line, the family shape: name, version, protocol revision, then each
 * sibling as resolved or "not installed".
 *
 * @param {ReturnType<typeof versionInfo>} info
 * @returns {string}
 */
export function formatVersionBanner(info) {
	const parts = [
		info.protocolRevision === null ? 'protocol rev unknown' : `protocol rev ${info.protocolRevision}`
	];
	for (const [sibling, version] of Object.entries(info.siblings)) {
		parts.push(`${sibling} ${version === null ? 'not installed' : version}`);
	}
	return `${info.name} ${info.version === null ? 'unknown' : info.version} (${parts.join(', ')})`;
}

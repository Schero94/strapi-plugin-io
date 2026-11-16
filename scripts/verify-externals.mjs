import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fail the build when host-provided packages end up inside dist/.
 *
 * Strapi's admin already ships React, styled-components, react-intl, the Design System and
 * icons; the server already ships @strapi/utils and @strapi/database. Bundling them makes the
 * package large and creates second copies with their own React context, error classes and
 * transaction context. They must stay external (peerDependencies, see package.json).
 *
 * @throws {Error} When a bundle inlines a host package or grows past the size budget.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const MAX_FILE_BYTES = 400 * 1024;

const problems = [];

for (const dir of ['dist/admin', 'dist/server']) {
	for (const name of await readdir(join(root, dir))) {
		const file = join(root, dir, name);
		const { size } = await stat(file);
		if (size > MAX_FILE_BYTES) problems.push(`${dir}/${name} is ${size} bytes (budget ${MAX_FILE_BYTES})`);
		const text = await readFile(file, 'utf8');
		// Markers that only exist inside the Design System / react-intl / @strapi/utils sources.
		if (
			/function DesignSystemProvider|Could not find required `intl` object|class ApplicationError extends Error/.test(
				text
			)
		) {
			problems.push(`${dir}/${name} inlines a host-provided package`);
		}
	}
}

const adminEntry = await readFile(join(root, 'dist/admin/index.mjs'), 'utf8');
const adminChunks = await Promise.all(
	(await readdir(join(root, 'dist/admin')))
		.filter((name) => name.endsWith('.mjs'))
		.map((name) => readFile(join(root, 'dist/admin', name), 'utf8'))
);
const adminCode = [adminEntry, ...adminChunks].join('\n');
for (const pkg of ['@strapi/design-system', '@strapi/icons', 'react-intl']) {
	if (!adminCode.includes(`from "${pkg}"`)) problems.push(`dist/admin does not import ${pkg} as an external`);
}

const serverCode = await readFile(join(root, 'dist/server/index.js'), 'utf8');
if (!serverCode.includes('require("@strapi/utils")'))
	problems.push('dist/server does not require @strapi/utils as an external');

if (problems.length) {
	throw new Error(`Bundle externals check failed:\n- ${problems.join('\n- ')}`);
}

console.log('Strapi IO bundles keep host-provided packages external');

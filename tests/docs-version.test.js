'use strict';

/**
 * Documentation drift checks.
 *
 * package.json is the single source of truth for the plugin version, the
 * supported Node.js range and the Strapi peer range. semantic-release bumps
 * package.json on every release, so documentation must never hard-code the
 * current plugin version; it either links to the GitHub release badge or
 * states facts that these tests compare with package.json.
 */

const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const currentMajor = Number(pkg.version.split('.')[0]);

/**
 * Recursively list files below a directory, skipping dependency and build folders.
 *
 * @param {string} dir Absolute directory path.
 * @param {(file: string) => boolean} keep Filter applied to each file path.
 * @returns {string[]} Absolute file paths.
 */
function walk(dir, keep) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'dist' || name === '.vitepress') continue;
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full, keep));
		else if (keep(full)) out.push(full);
	}
	return out;
}

const docFiles = [
	path.join(root, 'README.md'),
	path.join(root, 'api-reference.json'),
	...readdirSync(root)
		.filter((name) => /^llms.*\.txt$/.test(name))
		.map((name) => path.join(root, name)),
	...walk(path.join(root, 'docs'), (file) => /\.(md|html|txt|json)$/.test(file)),
].filter((file) => existsSync(file));

/**
 * @param {string} file Absolute path.
 * @returns {string} Path relative to the repository root, for assertion messages.
 */
const rel = (file) => path.relative(root, file);

/**
 * Collect regex matches across all documentation files.
 *
 * @param {RegExp} pattern Global regular expression.
 * @param {(match: RegExpMatchArray) => boolean} [isProblem] Decides whether a match is a finding.
 * @returns {string[]} Findings as `file: text`.
 */
function findAll(pattern, isProblem = () => true) {
	const findings = [];
	for (const file of docFiles) {
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(pattern)) {
			if (isProblem(match)) findings.push(`${rel(file)}: ${match[0].trim()}`);
		}
	}
	return findings;
}

test('docs do not hard-code a plugin version (package.json is the source of truth)', () => {
	const findings = [
		...findAll(/\b(?:plugin|widget)\s+version\**\s*[:|]\**\s*v?\d+(?:\.(?:\d+|x))+/gi),
		...findAll(/\*\*Version:\*\*\s*v?\d+(?:\.(?:\d+|x))+/gi),
	];
	assert.deepEqual(findings, [], 'hard-coded plugin version claims found');
});

test('docs only name the current plugin major as "this" version line', () => {
	const wrongMajor = (match) => Number(match[1]) !== currentMajor;
	const findings = [
		...findAll(/\b(?:this|current)\s+(?:version|release|line)\s*\(?\s*v(\d+)/gi, wrongMajor),
		...findAll(/\bthis\s+v(\d+)\b/gi, wrongMajor),
		...findAll(/\bv(\d+)(?:\.x)?\s+line\b/gi, wrongMajor),
		...findAll(/What's New in v(\d+)/gi, wrongMajor),
		...findAll(/\bPlugin to v(\d+)/gi, wrongMajor),
		...findAll(/\|\s*\*\*v(\d+)\.x\*\*\s*\|/g, wrongMajor),
		...findAll(/Migration[^\n]*?\bto\s+v(\d+)\b(?!\.\d)(?=[^\n]*\(Strapi)/gi, wrongMajor),
	];
	assert.deepEqual(findings, [], `version-line claims that do not match ${pkg.version}`);
});

test('VitePress config derives the nav version from package.json', () => {
	for (const name of ['config.js', 'config.mjs']) {
		const file = path.join(root, 'docs', '.vitepress', name);
		if (!existsSync(file)) continue;
		const text = readFileSync(file, 'utf8');
		assert.doesNotMatch(text, /text:\s*['"`]v\d+\.\d+/, `${rel(file)} hard-codes a version in the nav`);
	}
});

test('machine-readable docs carry no stale version fields', () => {
	for (const file of docFiles.filter((f) => f.endsWith('.json'))) {
		if (rel(file) === path.join('docs', 'package.json')) continue; // private VitePress tooling package
		const data = JSON.parse(readFileSync(file, 'utf8'));
		const stack = [data];
		while (stack.length) {
			const node = stack.pop();
			if (!node || typeof node !== 'object') continue;
			for (const [key, value] of Object.entries(node)) {
				if (key === 'version' || key === 'softwareVersion') {
					assert.equal(value, pkg.version, `${rel(file)} has ${key} ${value}, package.json has ${pkg.version}`);
				}
				stack.push(value);
			}
		}
	}
	const jsonLd = findAll(/"softwareVersion"\s*:\s*"([^"]+)"/g, (m) => m[1] !== pkg.version);
	assert.deepEqual(jsonLd, [], 'JSON-LD softwareVersion does not match package.json');
});

test('docs never tell users to install the upstream-owned npm package name', () => {
	// `strapi-plugin-io@2` stays allowed: it is the upstream Strapi v4 package named in downgrade steps.
	const findings = findAll(
		/\b(?:npm\s+(?:i|install|add)(?:\s+--?\S+)*|yarn\s+add|pnpm\s+(?:add|install))\s+strapi-plugin-io\b(?!@2\b)/gi
	);
	assert.deepEqual(findings, [], `"${pkg.name}" on npm is upstream-owned; document the GitHub install instead`);
});

test('README states the Node.js range and Strapi peer range from package.json', () => {
	const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
	assert.ok(readme.includes(pkg.engines.node), `README must mention engines.node ${pkg.engines.node}`);
	assert.ok(
		readme.includes(pkg.peerDependencies['@strapi/strapi']),
		`README must mention the @strapi/strapi peer range ${pkg.peerDependencies['@strapi/strapi']}`
	);
	const site = readFileSync(path.join(root, 'docs', 'site', 'index.html'), 'utf8');
	const escapedNode = pkg.engines.node.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	assert.ok(site.includes(escapedNode), `docs/site must mention engines.node ${pkg.engines.node}`);
});

'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('host-provided admin packages are optional peers, never dependencies', () => {
	for (const name of ['@strapi/design-system', '@strapi/icons', 'react-intl']) {
		assert.ok(pkg.peerDependencies[name], `${name} must be a peerDependency`);
		assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} must be an optional peer`);
		assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a dependency`);
	}
	assert.equal(pkg.peerDependencies['@strapi/design-system'], '^2.2.0');
	assert.equal(pkg.peerDependencies['@strapi/icons'], '^2.2.0');
});

test('Strapi server packages the bundle imports are declared peers', () => {
	assert.ok(pkg.peerDependencies['@strapi/strapi']);
	assert.ok(pkg.peerDependencies['@strapi/utils']);
});

test('engines.node matches the Strapi 5 range', () => {
	assert.equal(pkg.engines.node, '>=22.0.0 <=26.x.x');
});

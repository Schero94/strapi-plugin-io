'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const settingsPage = readFileSync(new URL('../admin/src/pages/SettingsPage.jsx', `file://${__filename}`), 'utf8');
const monitoringPage = readFileSync(new URL('../admin/src/pages/MonitoringPage.jsx', `file://${__filename}`), 'utf8');

test('settings controls expose keyboard-operable labels and origin removal buttons', () => {
	assert.match(settingsPage, /id="io-cors-origin"/);
	assert.match(settingsPage, /Field\.Label htmlFor="io-cors-origin"/);
	assert.match(settingsPage, /onKeyDown=\{\(e\) => e\.key === 'Enter' && addOrigin\(\)\}/);
	assert.match(settingsPage, /aria-label=\{`\$\{t\('cors\.remove'/);
	assert.match(settingsPage, /aria-label=\{t\('monitoring\.connectionLogging'/);
	assert.match(settingsPage, /aria-label=\{t\('monitoring\.eventLogging'/);
	assert.doesNotMatch(settingsPage, /<Badge[^>]*onClick=/);
});

test('monitoring settings do not make non-interactive card containers clickable', () => {
	const section = settingsPage.slice(settingsPage.indexOf("t('monitoring.title'"));
	assert.doesNotMatch(section, /<Box[\s\S]{0,300}onClick=/);
});

test('monitoring UI only renders sanitized client status and aggregate room counts', () => {
	assert.match(monitoringPage, /s\.authenticated \? 'Authenticated client' : 'Anonymous client'/);
	assert.match(monitoringPage, /s\.roomCount/);
	assert.match(monitoringPage, /aria-label=\{t\('monitoring\.refresh'/);
	assert.match(monitoringPage, /aria-label=\{t\('monitoring\.resetStats'/);
	assert.doesNotMatch(monitoringPage, /s\.user\?\.email|s\.handshake\.address|s\.id\}/);
});

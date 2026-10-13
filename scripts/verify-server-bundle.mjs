import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjsModule = require('../dist/server/index.js');
const esmModule = await import('../dist/server/index.mjs');
const cjsPlugin = cjsModule.default || cjsModule;
const esmPlugin = esmModule.default || esmModule;
const expectedTypes = {
  bootstrap: 'function',
  destroy: 'function',
  register: 'function',
  config: 'object',
  controllers: 'object',
  routes: 'object',
  services: 'object',
  contentTypes: 'object',
  middlewares: 'object',
  policies: 'object',
};

for (const [format, plugin] of [['CJS', cjsPlugin], ['ESM', esmPlugin]]) {
  for (const [key, expected] of Object.entries(expectedTypes)) {
    if (typeof plugin?.[key] !== expected) {
      throw new Error(`${format} server bundle export ${key} must be ${expected}, received ${typeof plugin?.[key]}`);
    }
  }
}

console.log('Strapi IO CJS and ESM server bundles load with all plugin exports');

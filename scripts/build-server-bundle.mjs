import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const externals = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.optionalDependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
  // Strapi core packages (@strapi/utils, @strapi/database, ...) come from the host's
  // @strapi/strapi install. Bundling them ships a second copy whose error classes and
  // transaction context are not the ones Strapi core uses at runtime.
  '@strapi/*',
]);

const commonOptions = {
  entryPoints: ['server/index.js'],
  bundle: true,
  platform: 'node',
  target: ['node22'],
  sourcemap: false,
  minify: false,
  external: [...externals],
  logLevel: 'info',
};

await build({ ...commonOptions, format: 'cjs', outfile: 'dist/server/index.js' });
await build({
  ...commonOptions,
  format: 'esm',
  outfile: 'dist/server/index.mjs',
  banner: {
    js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
  },
});

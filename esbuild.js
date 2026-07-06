const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  // The Agent SDK is ESM and reads import.meta.url at load time; shim it so
  // the CJS bundle can resolve the SDK's bundled CLI path.
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('watching...');
  } else {
    await esbuild.build(options);
    console.log('build done');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

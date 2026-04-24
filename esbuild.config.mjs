import esbuild from 'esbuild';

const prod = process.argv[2] === 'production';

esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  outfile: 'main.js',
  minify: prod,
  sourcemap: prod ? false : 'inline',
  platform: 'browser',
  logLevel: 'info',
}).catch(() => process.exit(1));

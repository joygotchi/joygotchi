import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

/**
 * Bundle the CLI into one file.
 *
 * `@joygotchi/pet` is a workspace package and is not published, so a tarball
 * that merely depends on it installs for nobody. Bundling is also the right
 * shape for something run through `npx`: one download, no dependency tree, and
 * no second package whose version has to move in step with this one.
 *
 * The art stays on disk next to the bundle rather than inlined — `files` in
 * package.json ships `assets/`, and `install.ts` resolves it from
 * `import.meta.url`, which esbuild leaves alone in ESM output.
 */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // Nothing is external: that is the whole point.
  external: []
});

// npm preserves the mode from the tarball, but a fresh build has to be marked
// executable or `npx joygotchi` fails with EACCES.
await chmod('dist/index.js', 0o755);

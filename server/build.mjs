// Bundles the server and its routing threads into dist/. The routing code is
// imported straight from ../worker/src, so the server and the Cloudflare Worker
// run exactly the same handlers.
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts', router: 'src/router-thread.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
});

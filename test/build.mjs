// Bundles the core layer against a stubbed `obsidian` module and runs the checks.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, '.build/run.mjs');

await esbuild.build({
  entryPoints: [resolve(here, 'run.ts')],
  bundle: true,
  outfile,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  alias: { obsidian: resolve(here, 'stubs/obsidian.ts') },
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);

import process from 'node:process';
import { builtinModules } from 'node:module';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Every path here is resolved against the repo root rather than the caller's cwd, so
// the build behaves the same however it is invoked.
const rootDir = import.meta.dirname;

// The folder name Obsidian expects under .obsidian/plugins is the manifest id, so
// read it from there rather than repeating it.
const manifest = JSON.parse(await readFile(join(rootDir, 'manifest.json'), 'utf8'));
const pluginId = manifest.id?.trim();
if (!pluginId) throw new Error('manifest.json is missing an "id".');

/**
 * Where the three plugin files land, most specific first:
 *
 *  - OBSIDIAN_PLUGIN_DIR — an exact plugin folder.
 *  - OBSIDIAN_VAULT      — a vault root; the plugin folder is derived from it.
 *  - otherwise            dist/, flat — the location Obsidian's community-plugin build
 *                          verification looks for (repo root, dist/, or build/); rename
 *                          it to the manifest id when dropping it into .obsidian/plugins.
 *
 * A relative override is taken relative to the repo root, not the cwd.
 */
function outputDir() {
  const explicit = process.env.OBSIDIAN_PLUGIN_DIR?.trim();
  if (explicit) return { dir: absolute(explicit), installed: true };

  const vault = process.env.OBSIDIAN_VAULT?.trim();
  if (vault) {
    return { dir: join(absolute(vault), '.obsidian', 'plugins', pluginId), installed: true };
  }

  return { dir: join(rootDir, 'dist'), installed: false };
}

function absolute(path) {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

const { dir: outDir, installed } = outputDir();

// Everything Obsidian needs to load the plugin. Nothing else belongs in the folder;
// in particular data.json (the user's settings) lives there too and is never touched.
const STATIC_FILES = ['manifest.json', 'styles.css'];

const copyStatic = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await mkdir(outDir, { recursive: true });
      for (const file of STATIC_FILES) {
        await copyFile(join(rootDir, file), join(outDir, file)).catch((error) => {
          console.warn(`[build] could not copy ${file}: ${error.message}`);
        });
      }
      const time = new Date().toLocaleTimeString();
      console.log(`[build] ${time} -> ${join(outDir, 'main.js')}`);
      if (!installed) {
        console.log(`[build] copy ${outDir} into <vault>/.obsidian/plugins/${pluginId}/`);
      }
    });
  },
};

const context = await esbuild.context({
  absWorkingDir: rootDir,
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: join(outDir, 'main.js'),
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  minify: production,
  treeShaking: true,
  plugins: [copyStatic],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}

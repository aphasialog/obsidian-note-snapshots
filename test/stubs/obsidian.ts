/**
 * Minimal stand-ins for the Obsidian runtime values the core layer imports.
 *
 * `esbuild` aliases the `obsidian` module to this file when bundling the checks, so
 * the core runs unmodified against `test/fake-vault.ts`. The extra fields on `TFile`
 * exist only to stay structurally assignable to the real declaration, since the
 * type checker still sees the published `obsidian` types.
 */

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

export class TFile {
	path = '';
	name = '';
	basename = '';
	extension = '';
	stat = { ctime: 0, mtime: 0, size: 0 };
	/* eslint-disable @typescript-eslint/no-explicit-any */
	vault: any = null;
	parent: any = null;
}

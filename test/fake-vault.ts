import { TFile } from './stubs/obsidian';

/**
 * An in-memory stand-in for the slice of the Obsidian API the core layer touches:
 * the raw adapter, the note-level vault helpers, the metadata cache, and
 * `processFrontMatter`.
 */
export class FakeVault {
	readonly disk = new Map<string, string>();
	readonly binaryDisk = new Map<string, ArrayBuffer>();
	private readonly dirs = new Set<string>();
	private readonly notes = new Map<string, TFile>();

	/** Counts adapter writes so tests can assert that nothing was written. */
	writes = 0;

	createNote(path: string, body: string): TFile {
		this.disk.set(path, body);
		const file = this.makeFile(path);
		this.notes.set(path, file);
		return file;
	}

	/** Registers a binary file (an attachment) directly on disk. */
	createAttachment(path: string, data: ArrayBuffer): TFile {
		this.binaryDisk.set(path, data);
		const file = this.makeFile(path);
		this.notes.set(path, file);
		return file;
	}

	/** Removes an attachment, as if some unrelated "orphan file" cleanup plugin did it. */
	deleteAttachment(path: string): void {
		this.binaryDisk.delete(path);
		this.notes.delete(path);
	}

	/** Renames as Obsidian does: the same TFile object, mutated in place. */
	renameNote(file: TFile, newPath: string): string {
		const oldPath = file.path;
		const content = this.disk.get(oldPath) ?? '';
		this.disk.delete(oldPath);
		this.notes.delete(oldPath);
		this.disk.set(newPath, content);
		Object.assign(file, this.describe(newPath));
		this.notes.set(newPath, file);
		return oldPath;
	}

	/** Byte-for-byte duplicate, frontmatter included — the copy case from §4. */
	copyNote(file: TFile, newPath: string): TFile {
		return this.createNote(newPath, this.disk.get(file.path) ?? '');
	}

	deleteNote(file: TFile): void {
		this.disk.delete(file.path);
		this.notes.delete(file.path);
	}

	/** Files under the snapshot store, for asserting on what is on disk. */
	storeFiles(prefix = '.note-snapshots'): string[] {
		return [...this.disk.keys(), ...this.binaryDisk.keys()]
			.filter((path) => path.startsWith(`${prefix}/`))
			.sort();
	}

	private makeFile(path: string): TFile {
		const file = new TFile();
		Object.assign(file, this.describe(path));
		return file;
	}

	private describe(path: string): Pick<TFile, 'path' | 'name' | 'basename' | 'extension'> {
		const name = path.slice(path.lastIndexOf('/') + 1);
		const dot = name.lastIndexOf('.');
		return {
			path,
			name,
			basename: dot === -1 ? name : name.slice(0, dot),
			extension: dot === -1 ? '' : name.slice(dot + 1),
		};
	}

	/** The object handed to the core as `app`. */
	get app(): any {
		const disk = this.disk;
		const binaryDisk = this.binaryDisk;
		const dirs = this.dirs;
		const self = this;

		const adapter = {
			async exists(path: string): Promise<boolean> {
				return disk.has(path) || binaryDisk.has(path) || dirs.has(path);
			},
			async read(path: string): Promise<string> {
				const value = disk.get(path);
				if (value === undefined) throw new Error(`ENOENT: ${path}`);
				return value;
			},
			async stat(
				path: string,
			): Promise<{ type: 'file' | 'folder'; size: number; ctime: number; mtime: number } | null> {
				const text = disk.get(path);
				if (text !== undefined) {
					return { type: 'file', size: new TextEncoder().encode(text).length, ctime: 0, mtime: 0 };
				}
				const binary = binaryDisk.get(path);
				if (binary !== undefined) return { type: 'file', size: binary.byteLength, ctime: 0, mtime: 0 };
				if (dirs.has(path)) return { type: 'folder', size: 0, ctime: 0, mtime: 0 };
				return null;
			},
			async readBinary(path: string): Promise<ArrayBuffer> {
				const value = binaryDisk.get(path);
				if (value === undefined) throw new Error(`ENOENT: ${path}`);
				return value;
			},
			async write(path: string, data: string): Promise<void> {
				self.writes++;
				disk.set(path, data);
			},
			async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
				self.writes++;
				binaryDisk.set(path, data);
			},
			async remove(path: string): Promise<void> {
				disk.delete(path);
				binaryDisk.delete(path);
			},
			async mkdir(path: string): Promise<void> {
				dirs.add(path);
			},
			async rmdir(path: string, _recursive: boolean): Promise<void> {
				for (const key of [...disk.keys()]) {
					if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
				}
				for (const key of [...binaryDisk.keys()]) {
					if (key === path || key.startsWith(`${path}/`)) binaryDisk.delete(key);
				}
				for (const dir of [...dirs]) {
					if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
				}
			},
			async rename(from: string, to: string): Promise<void> {
				const value = disk.get(from);
				if (value === undefined) throw new Error(`ENOENT: ${from}`);
				disk.set(to, value);
				disk.delete(from);
			},
		};

		return {
			vault: {
				adapter,
				async read(file: TFile): Promise<string> {
					return adapter.read(file.path);
				},
				async cachedRead(file: TFile): Promise<string> {
					return adapter.read(file.path);
				},
				async readBinary(file: TFile): Promise<ArrayBuffer> {
					return adapter.readBinary(file.path);
				},
				async modify(file: TFile, content: string): Promise<void> {
					disk.set(file.path, content);
				},
				async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
					self.writes++;
					binaryDisk.set(file.path, data);
				},
				getAbstractFileByPath(path: string): TFile | null {
					return self.notes.get(path) ?? null;
				},
			},
			metadataCache: {
				getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null {
					const content = disk.get(file.path);
					if (content === undefined) return null;
					const frontmatter = parseFrontmatter(content);
					return frontmatter ? { frontmatter } : {};
				},
			},
			fileManager: {
				async processFrontMatter(
					file: TFile,
					mutate: (frontmatter: Record<string, unknown>) => void,
				): Promise<void> {
					const content = disk.get(file.path) ?? '';
					const frontmatter = parseFrontmatter(content) ?? {};
					mutate(frontmatter);
					disk.set(file.path, serialise(frontmatter, stripFrontmatter(content)));
				},
				/** Mirrors Obsidian: mutates the same TFile in place, refuses an occupied path. */
				async renameFile(file: TFile, newPath: string): Promise<void> {
					if (disk.has(newPath) || binaryDisk.has(newPath)) {
						throw new Error(`destination exists: ${newPath}`);
					}
					const content = disk.get(file.path);
					if (content === undefined) throw new Error(`ENOENT: ${file.path}`);
					disk.delete(file.path);
					self.notes.delete(file.path);
					disk.set(newPath, content);
					Object.assign(file, self.describe(newPath));
					self.notes.set(newPath, file);
				},
			},
		};
	}
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(content: string): Record<string, unknown> | null {
	const match = FENCE.exec(content);
	if (!match?.[1]) return null;
	const result: Record<string, unknown> = {};
	for (const line of match[1].split('\n')) {
		const separator = line.indexOf(':');
		if (separator === -1) continue;
		result[line.slice(0, separator).trim()] = line
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, '');
	}
	return Object.keys(result).length > 0 ? result : null;
}

function stripFrontmatter(content: string): string {
	return content.replace(FENCE, '');
}

function serialise(frontmatter: Record<string, unknown>, body: string): string {
	const entries = Object.entries(frontmatter);
	if (entries.length === 0) return body;
	const lines = entries.map(([key, value]) => `${key}: ${String(value)}`);
	return `---\n${lines.join('\n')}\n---\n${body}`;
}

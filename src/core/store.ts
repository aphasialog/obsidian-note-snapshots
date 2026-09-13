import type { App } from 'obsidian';
import { SCHEMA_VERSION, type CentralManifest, type NoteManifest } from '@/types';
import { TaskQueue } from '@/util/task-queue';
import type { Paths } from '@/core/paths';

/** Queue key for the central manifest. Not a valid note id, so it cannot collide. */
const CENTRAL_QUEUE_KEY = 'central-manifest/';

/**
 * Reads and writes the JSON manifests and snapshot content files.
 *
 * Everything goes through the vault adapter rather than the `TFile` API: the store
 * lives in a dot-folder that Obsidian does not index, so there are no `TFile`s for it.
 */
export class Store {
	private central: CentralManifest | null = null;

	constructor(
		private readonly app: App,
		private readonly paths: Paths,
		private readonly queue: TaskQueue,
	) {}

	// --- Central manifest (central.json, shared by every note) ---

	/** Drops the cached central manifest, e.g. after the store path setting changes. */
	invalidate(): void {
		this.central = null;
	}

	async loadCentralJson(): Promise<CentralManifest> {
		if (this.central) return this.central;
		this.central = await this.readCentralJsonFromDisk();
		return this.central;
	}

	/** Serialised read-modify-write of the central manifest. */
	async updateCentralJson(mutate: (manifest: CentralManifest) => void): Promise<void> {
		return this.queue.run(CENTRAL_QUEUE_KEY, async () => {
			// Bypasses the cache: something outside this plugin (a sync client) may have
			// written a newer central.json since we last loaded it, and writing back a
			// stale cache here would silently discard whatever it brought in.
			const manifest = await this.readCentralJsonFromDisk();
			mutate(manifest);
			this.central = manifest;
			await this.writeJson(this.paths.centralJson(), manifest);
		});
	}

	private async readCentralJsonFromDisk(): Promise<CentralManifest> {
		const parsed = await this.readJson<CentralManifest>(this.paths.centralJson());
		return parsed && typeof parsed.notes === 'object' && parsed.notes !== null
			? { schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION, notes: parsed.notes }
			: { schemaVersion: SCHEMA_VERSION, notes: {} };
	}

	// --- Note manifest (one manifest.json per note) ---

	async loadNoteJson(noteId: string): Promise<NoteManifest | null> {
		const parsed = await this.readJson<NoteManifest>(this.paths.noteJson(noteId));
		if (!parsed || typeof parsed.snapshots !== 'object' || parsed.snapshots === null) return null;
		return {
			schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
			noteId,
			latestPath: typeof parsed.latestPath === 'string' ? parsed.latestPath : '',
			createdAt: parsed.createdAt ?? new Date().toISOString(),
			activeSnapshotId: typeof parsed.activeSnapshotId === 'string' ? parsed.activeSnapshotId : null,
			snapshots: parsed.snapshots,
		};
	}

	async saveNoteJson(manifest: NoteManifest): Promise<void> {
		await this.writeJson(this.paths.noteJson(manifest.noteId), manifest);
	}

	// --- Snapshot content files ---

	async readSnapshot(noteId: string, snapshotId: string): Promise<string | null> {
		const path = this.paths.snapshotFile(noteId, snapshotId);
		if (!(await this.app.vault.adapter.exists(path))) return null;
		return this.app.vault.adapter.read(path);
	}

	/** Writes snapshot content and returns its byte length. */
	async writeSnapshot(noteId: string, snapshotId: string, content: string): Promise<number> {
		await this.ensureDir(this.paths.noteDir(noteId));
		await this.app.vault.adapter.write(this.paths.snapshotFile(noteId, snapshotId), content);
		return new TextEncoder().encode(content).length;
	}

	async removeSnapshot(noteId: string, snapshotId: string): Promise<void> {
		const path = this.paths.snapshotFile(noteId, snapshotId);
		if (await this.app.vault.adapter.exists(path)) {
			await this.app.vault.adapter.remove(path);
		}
	}

	// --- Attachment blobs ---

	async readAttachment(noteId: string, hash: string): Promise<ArrayBuffer | null> {
		const path = this.paths.attachmentFile(noteId, hash);
		if (!(await this.app.vault.adapter.exists(path))) return null;
		return this.app.vault.adapter.readBinary(path);
	}

	/** Writes an attachment blob, deduplicated by hash: a repeat write is a no-op. */
	async writeAttachment(noteId: string, hash: string, data: ArrayBuffer): Promise<void> {
		const path = this.paths.attachmentFile(noteId, hash);
		if (await this.app.vault.adapter.exists(path)) return;
		await this.ensureDir(this.paths.noteDir(noteId));
		await this.ensureDir(this.paths.attachmentsDir(noteId));
		await this.app.vault.adapter.writeBinary(path, data);
	}

	async removeAttachment(noteId: string, hash: string): Promise<void> {
		const path = this.paths.attachmentFile(noteId, hash);
		if (await this.app.vault.adapter.exists(path)) {
			await this.app.vault.adapter.remove(path);
		}
	}

	// --- Whole-note removal ---

	/** Deletes a note's entire on-disk history: its manifest, every snapshot, and every attachment. */
	async removeNoteStore(noteId: string): Promise<void> {
		const dir = this.paths.noteDir(noteId);
		if (!(await this.app.vault.adapter.exists(dir))) return;
		await this.app.vault.adapter.rmdir(dir, true);
	}

	// --- Low-level file I/O ---

	private async ensureDir(path: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(path))) {
			await this.app.vault.adapter.mkdir(path);
		}
	}

	private async readJson<T>(path: string): Promise<Partial<T> | null> {
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const raw = await this.app.vault.adapter.read(path);
			const parsed: unknown = JSON.parse(raw);
			return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<T>) : null;
		} catch (error) {
			console.error(`Note Snapshots: could not read ${path}. Treating as missing.`, error);
			return null;
		}
	}

	/**
	 * Writes JSON via a temporary file and a rename, so an interrupted write cannot
	 * leave a truncated manifest behind.
	 */
	private async writeJson(path: string, value: unknown): Promise<void> {
		const serialised = JSON.stringify(value, null, 2);
		const dir = path.slice(0, path.lastIndexOf('/'));
		await this.ensureDir(this.paths.root());
		if (dir !== this.paths.root()) await this.ensureDir(dir);

		const adapter = this.app.vault.adapter;
		const temporary = `${path}.tmp`;
		await adapter.write(temporary, serialised);
		try {
			if (await adapter.exists(path)) await adapter.remove(path);
			await adapter.rename(temporary, path);
		} catch (error) {
			// Fall back to a direct write rather than losing the update entirely.
			console.error(`Note Snapshots: atomic write failed for ${path}.`, error);
			await adapter.write(path, serialised);
			await adapter.remove(temporary).catch(() => undefined);
		}
	}
}

import { TFile, type App } from 'obsidian';
import type { Store } from '@/core/store';
import type { TaskQueue } from '@/util/task-queue';
import { readNoteId, writeNoteId } from '@/util/frontmatter';

/**
 * Owns the mapping between a note and its history.
 *
 * Identity is a random id stored in the note's frontmatter, never derived from the
 * path. The `path` recorded in the central manifest is a display and recovery hint
 * that is allowed to go stale; it is repaired lazily whenever a note is resolved.
 */
export class IdentityService {
	constructor(
		private readonly app: App,
		private readonly store: Store,
		private readonly queue: TaskQueue,
		/** Called when a duplicated note is forked onto a fresh history. */
		private readonly onFork: (file: TFile) => void = () => undefined,
	) {}

	// --- Resolving or minting a note's id ---

	/** Resolves a note's id without creating anything. Null when it has no history. */
	async resolveNoteId(file: TFile): Promise<string | null> {
		if (file.extension !== 'md') return null;
		const claimedId = await readNoteId(this.app, file);
		if (claimedId) return this.reconcileNoteId(file, claimedId);
		return this.recoverAndStampId(file);
	}

	/** Resolves a note's id, minting and stamping one if it has none. */
	async resolveOrCreateNoteId(file: TFile): Promise<string> {
		if (file.extension !== 'md') {
			throw new Error('Note Snapshots tracks markdown notes only.');
		}
		const existing = await this.resolveNoteId(file);
		if (existing) return existing;

		const noteId = newNoteId();
		await writeNoteId(this.app, file, noteId);
		await this.registerNoteId(noteId, file.path);
		return noteId;
	}

	/**
	 * Reconciles a note's claimed id against the central manifest: decide whether the
	 * recorded path is simply stale (a move) or whether a second live file is claiming
	 * the same history (a copy).
	 */
	private async reconcileNoteId(file: TFile, claimedId: string): Promise<string> {
		const central = await this.store.loadCentralJson();
		const entry = central.notes[claimedId];

		if (!entry) {
			// The note carries an id we have no record of — adopt it, so a lost or
			// partially synced central manifest does not orphan an existing history.
			await this.registerNoteId(claimedId, file.path);
			return claimedId;
		}

		if (entry.latestPath === file.path) {
			if (entry.orphanedAt !== undefined) {
				// The note is back (undo, or sync restored it). Un-orphan it.
				await this.store.updateCentralJson((manifest) => {
					const current = manifest.notes[claimedId];
					if (current) delete current.orphanedAt;
				});
			}
			return claimedId;
		}

		if (await this.shouldForkFile(entry.latestPath, claimedId, file.path)) {
			const forked = newNoteId();
			await writeNoteId(this.app, file, forked);
			await this.registerNoteId(forked, file.path);
			this.onFork(file);
			return forked;
		}

		// The recorded path is gone, or now holds an unrelated note: this was a move.
		await this.updatePath(claimedId, file.path);
		return claimedId;
	}

	/**
	 * Last resort when a note carries no id: find a history recorded against this
	 * exact path, then stamp that id back into the note's frontmatter so it carries
	 * one again. Covers frontmatter stripped by an external tool.
	 */
	private async recoverAndStampId(file: TFile): Promise<string | null> {
		const central = await this.store.loadCentralJson();
		for (const [noteId, entry] of Object.entries(central.notes)) {
			// Skip orphans, so a brand-new note reusing a deleted note's path does not
			// silently inherit its history.
			if (entry.latestPath !== file.path || entry.orphanedAt !== undefined) continue;
			const manifest = await this.store.loadNoteJson(noteId);
			if (!manifest || Object.keys(manifest.snapshots).length === 0) continue;
			await writeNoteId(this.app, file, noteId);
			return noteId;
		}
		return null;
	}

	/**
	 * True when `selfPath` should be treated as a fork: a different live note already
	 * sitting at `path` independently claims the same `noteId`, so two live files are
	 * claiming one history. `selfPath` is the one not sitting at the recorded path, so
	 * it is the newcomer — it forks onto an empty history and the original keeps
	 * everything.
	 */
	private async shouldForkFile(path: string, noteId: string, selfPath: string): Promise<boolean> {
		if (path === selfPath) return false;
		const other = this.app.vault.getAbstractFileByPath(path);
		if (!(other instanceof TFile)) return false;
		return (await readNoteId(this.app, other)) === noteId;
	}

	private async registerNoteId(noteId: string, latestPath: string): Promise<void> {
		await this.store.updateCentralJson((manifest) => {
			manifest.notes[noteId] = { latestPath, updatedAt: new Date().toISOString() };
		});
	}

	// --- Keeping the recorded path in sync with vault events ---

	/** Updates the cached path in both manifests. Never touches identity. */
	async updatePath(noteId: string, latestPath: string): Promise<void> {
		await this.store.updateCentralJson((manifest) => {
			const entry = manifest.notes[noteId];
			if (entry) {
				entry.latestPath = latestPath;
				entry.updatedAt = new Date().toISOString();
				delete entry.orphanedAt;
			} else {
				manifest.notes[noteId] = { latestPath, updatedAt: new Date().toISOString() };
			}
		});
		await this.queue.run(noteId, async () => {
			const note = await this.store.loadNoteJson(noteId);
			if (!note || note.latestPath === latestPath) return;
			note.latestPath = latestPath;
			await this.store.saveNoteJson(note);
		});
	}

	/** Handles an in-vault rename or move: a path-cache update, nothing more. */
	async handleRename(file: TFile, oldPath: string): Promise<void> {
		if (file.extension !== 'md') return;
		const claimedId = await readNoteId(this.app, file);
		const noteId = claimedId ?? (await this.findNoteIdByPath(oldPath));
		if (!noteId) return;
		await this.updatePath(noteId, file.path);
	}

	/**
	 * Marks a deleted note's history as orphaned. History is kept rather than
	 * destroyed, because a delete is often an accident and Obsidian's own delete is
	 * recoverable from trash.
	 */
	async handleDelete(path: string): Promise<void> {
		const noteId = await this.findNoteIdByPath(path);
		if (!noteId) return;
		await this.store.updateCentralJson((manifest) => {
			const entry = manifest.notes[noteId];
			if (entry) entry.orphanedAt = new Date().toISOString();
		});
	}

	private async findNoteIdByPath(path: string): Promise<string | null> {
		const central = await this.store.loadCentralJson();
		for (const [noteId, entry] of Object.entries(central.notes)) {
			if (entry.latestPath === path) return noteId;
		}
		return null;
	}

	// --- Purging orphaned histories ---

	/** Ids whose note was deleted at least `days` ago. */
	async listPurgeableOrphans(days: number): Promise<string[]> {
		const central = await this.store.loadCentralJson();
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const purgeable: string[] = [];
		for (const [noteId, entry] of Object.entries(central.notes)) {
			if (entry.orphanedAt === undefined) continue;
			const orphanedAt = Date.parse(entry.orphanedAt);
			if (Number.isFinite(orphanedAt) && orphanedAt <= cutoff) purgeable.push(noteId);
		}
		return purgeable;
	}

	/** Permanently removes the histories of notes deleted long enough ago. */
	async purgeOrphans(days: number): Promise<number> {
		const purgeable = await this.listPurgeableOrphans(days);
		for (const noteId of purgeable) {
			await this.queue.run(noteId, () => this.store.removeNoteStore(noteId));
			await this.store.updateCentralJson((manifest) => {
				delete manifest.notes[noteId];
			});
		}
		return purgeable.length;
	}
}

/** Generates a path-safe random id. */
function newNoteId(): string {
	return globalThis.crypto?.randomUUID
		? globalThis.crypto.randomUUID().replace(/-/g, '')
		: Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

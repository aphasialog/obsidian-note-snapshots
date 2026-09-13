import { TFile, type App } from 'obsidian';
import type { Store } from '@/core/store';
import type { TaskQueue } from '@/util/task-queue';
import { readNoteIdFromFrontmatter, writeNoteIdToFrontmatter } from '@/util/frontmatter';

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

	/**
	 * Resolves a note's id without creating anything. Null when it has no history —
	 * including when its `ns-id` is missing or unreadable. No path-based guessing:
	 * the plugin never silently links a note to history it did not itself claim.
	 */
	async resolveNoteId(file: TFile): Promise<string | null> {
		if (file.extension !== 'md') return null;
		const claimedId = await readNoteIdFromFrontmatter(this.app, file);
		return claimedId ? this.reconcileNoteId(file, claimedId) : null;
	}

	/** Resolves a note's id, minting and stamping one if it has none. */
	async resolveOrCreateNoteId(file: TFile): Promise<string> {
		if (file.extension !== 'md') {
			throw new Error('Note Snapshots tracks markdown notes only.');
		}
		const existing = await this.resolveNoteId(file);
		if (existing) return existing;

		const noteId = newNoteId();
		await writeNoteIdToFrontmatter(this.app, file, noteId);
		await this.registerNoteId(noteId, file.path);
		return noteId;
	}

	/**
	 * Reconciles a note's claimed id against the central manifest: decide whether the
	 * recorded path is simply stale (a move) or whether a second live file is claiming
	 * the same history (a copy).
	 */
	private async reconcileNoteId(file: TFile, claimedId: string): Promise<string> {
		const central = await this.store.getCentralManifest();
		const entry = central.notes[claimedId];

		// Case 1: the note id is not recorded — adopt it, so a lost or partially synced
		// central manifest does not orphan an existing history.
		if (!entry) {
			await this.registerNoteId(claimedId, file.path);
			return claimedId;
		}

		// Case 2: the note is exactly where the record says it is.
		if (entry.latestPath === file.path) {
			if (entry.orphanedAt !== undefined) {
				// The note is back (undo, or sync restored it). Un-orphan it.
				await this.store.mutateCentralManifest((manifest) => {
					const current = manifest.notes[claimedId];
					if (current) delete current.orphanedAt;
				});
			}
			return claimedId;
		}

		// Case 3: a different live file already sits at the recorded path claiming the
		// same id — this file is the copy. Fork it onto a fresh, empty history.
		if (await this.shouldForkFile(entry.latestPath, claimedId, file.path)) {
			const forked = newNoteId();
			await writeNoteIdToFrontmatter(this.app, file, forked);
			await this.registerNoteId(forked, file.path);
			this.onFork(file);
			return forked;
		}

		// Case 4: the file was moved, so the recorded path is stale — nothing else at
		// the old path claims this id (Case 3 would have caught a fork). Update it.
		await this.updateLatestPath(claimedId, file.path);
		return claimedId;
	}

	/**
	 * True when `selfPath` should be treated as a fork: a different live note already
	 * sitting at `path` independently claims the same `noteId`, so two live files are
	 * claiming one history.
	 *
	 * `selfPath` is the one not sitting at the recorded path, so it is the newcomer —
	 * it forks onto an empty history and the original keeps everything.
	 */
	private async shouldForkFile(path: string, noteId: string, selfPath: string): Promise<boolean> {
		// Sanity check — the caller already knows the paths differ, so this should never fire.
		if (path === selfPath) return false;
		const other = this.app.vault.getAbstractFileByPath(path);
		if (!(other instanceof TFile)) return false;
		return (await readNoteIdFromFrontmatter(this.app, other)) === noteId;
	}

	private async registerNoteId(noteId: string, latestPath: string): Promise<void> {
		await this.store.mutateCentralManifest((manifest) => {
			manifest.notes[noteId] = { latestPath, updatedAt: new Date().toISOString() };
		});
	}

	// --- Keeping the recorded path in sync with vault events ---

	/** Updates the cached path in both manifests. Never touches identity. */
	async updateLatestPath(noteId: string, latestPath: string): Promise<void> {
		await this.store.mutateCentralManifest((manifest) => {
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
			const note = await this.store.loadNoteManifest(noteId);
			if (!note || note.latestPath === latestPath) return;
			note.latestPath = latestPath;
			await this.store.saveNoteManifest(note);
		});
	}

	/**
	 * Handles an in-vault rename or move: a path-cache update, nothing more.
	 *
	 * Trusts frontmatter only — no path-based fallback. If the id is gone from
	 * frontmatter, that note is untracked as far as this plugin is concerned; trying
	 * to infer its identity from the old path would be exactly the kind of guess
	 * identity is designed never to depend on.
	 */
	async handleRename(file: TFile): Promise<void> {
		if (file.extension !== 'md') return;
		const noteId = await readNoteIdFromFrontmatter(this.app, file);
		if (!noteId) return;
		await this.updateLatestPath(noteId, file.path);
	}

	/**
	 * Marks a deleted note's history as orphaned. History is kept rather than
	 * destroyed, because a delete is often an accident and Obsidian's own delete is
	 * recoverable from trash.
	 */
	async handleDelete(path: string): Promise<void> {
		const noteId = await this.findNoteIdByPath(path);
		if (!noteId) return;
		await this.store.mutateCentralManifest((manifest) => {
			const entry = manifest.notes[noteId];
			if (entry) entry.orphanedAt = new Date().toISOString();
		});
	}

	/**
	 * Finds a note id whose central-manifest entry's `latestPath` matches `path`.
	 *
	 * Used only by `handleDelete`, which has no alternative: the file is already gone
	 * by the time it fires, so there is no frontmatter left to read, and this lookup
	 * is the only way to identify which note's history to orphan.
	 */
	private async findNoteIdByPath(path: string): Promise<string | null> {
		const central = await this.store.getCentralManifest();
		for (const [noteId, entry] of Object.entries(central.notes)) {
			if (entry.latestPath === path) return noteId;
		}
		return null;
	}

	// --- Purging orphaned histories ---

	/** Ids whose note was deleted at least `days` ago. */
	async listPurgeableOrphans(days: number): Promise<string[]> {
		const central = await this.store.getCentralManifest();
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
			await this.store.mutateCentralManifest((manifest) => {
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

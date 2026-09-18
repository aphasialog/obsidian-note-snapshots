import type { App, TFile } from 'obsidian';
import {
	type AttachmentRef,
	type NoteManifest,
	type SnapshotOutcome,
	SCHEMA_VERSION,
	type SnapshotMetadata,
	type SnapshotRow,
	type WorkingState,
} from '@/types';
import type { Store } from '@/core/store';
import type { IdentityService } from '@/core/identity';
import type { TaskQueue } from '@/util/task-queue';
import { algorithmsDiffer, hashNoteContent } from '@/util/hash';
import {
	captureAttachments,
	hasSnapshotWithAttachment,
	planAttachmentChanges,
	restoreAttachments,
	type AttachmentChange,
	type AttachmentConflictMode,
} from '@/core/attachments';

export type { AttachmentConflictMode };

/** The name given to the one automatic snapshot the plugin ever takes. */
export const UNSAVED_LABEL = 'Unsaved work before restore';

/**
 * What a restore would touch beyond the note body, computed before asking the user.
 *
 * This is the proposal `restoreSnapshot`/`backupAndRestoreSnapshot` execute — not a
 * preview they re-verify. `attachmentChanges` is the raw data they act on directly;
 * the rest are basenames derived from it, for display only. See "Risks" in
 * docs/implementation-plan.md for why re-scanning the vault a second time at restore
 * time was deliberately not done.
 */
export interface RestorePlan {
	target: SnapshotRow;
	/**
	 * The working file's state, or null if it could not be read. This is
	 * `getWorkingState`'s answer, not the cheap `getProxyWorkingState()`'s — text
	 * matching snapshot X while its attachments have since changed is real unsaved
	 * work, not a clean checkout of X, and reads as `unsaved` here even though text
	 * alone would call it clean.
	 *
	 * Even so, a caller deciding whether to confirm should not treat "clean" here as
	 * "nothing to ask about" for the *target* being restored to —
	 * `attachmentsToOverwriteAndCaptured`/`Uncaptured` below is the independent signal
	 * for that, checked against the target rather than the working state; the UI checks
	 * those first and consults `workingState` only once they're both empty (see
	 * `decideRestore`).
	 */
	workingState: WorkingState | null;
	/** What `restoreSnapshot`/`backupAndRestoreSnapshot` execute against directly. */
	attachmentChanges: AttachmentChange[];

	// Everything below is derived from `attachmentChanges` above, for display only —
	// reporting, not execution.
	/** Missing attachments this restore wants to recreate — basenames. */
	attachmentsToRecreate: string[];
	/** Changed attachments this restore wants to overwrite, already captured in another snapshot — basenames. */
	attachmentsToOverwriteAndCaptured: string[];
	/** Changed attachments this restore wants to overwrite, captured nowhere else — replacing one destroys its only copy for good, unless a same-call backup happens to capture it first — basenames. */
	attachmentsToOverwriteAndUncaptured: string[];
	/** Present attachments too large to compare; a restore leaves them as they are. */
	attachmentsAssumedUnchanged: string[];
}

export interface RestoreOutcome {
	restored: SnapshotRow;
	/** Set when unsaved work had to be captured first (rule R4), or a backup was forced. */
	backup: SnapshotRow | null;
	/** How many missing attachments this restore recreated, from the target snapshot's own stored copy. */
	attachmentsRecreated: number;
	/** Changed attachments this restore overwrote, already captured in another snapshot — basenames. */
	attachmentsOverwrittenAndRecoverable: string[];
	/** Changed attachments this restore overwrote even though captured nowhere else — gone for good — basenames. */
	attachmentsOverwrittenAndUnrecoverable: string[];
	/** Changed attachments left in place — mode `skip` — basenames. */
	attachmentsSkipped: string[];
}

/**
 * Manages the snapshot history of every note, one at a time per call.
 *
 * Four rules govern everything here:
 *
 *  - R1 Restoring is a checkout. It writes content and moves `activeSnapshotId`; it never
 *       creates a snapshot. It does not rename or move the note — that is the
 *       user's to do.
 *  - R3 `activeSnapshotId` records which snapshot the working file currently matches.
 *  - R4 The only automatic snapshot fires when the working content matches no
 *       stored snapshot, i.e. real unsaved work would otherwise be lost.
 *
 * Together these make flipping between two snapshots free: no new snapshots, forever.
 */
export class SnapshotService {
	constructor(
		private readonly app: App,
		private readonly store: Store,
		private readonly identity: IdentityService,
		private readonly queue: TaskQueue,
		/** Reads what the user currently sees, which may not be flushed to disk yet. */
		private readonly readNoteContent: (file: TFile) => Promise<string>,
		/** Live read of the user's large-attachment threshold (MB), converted to bytes. */
		private readonly getLargeAttachmentThresholdBytes: () => number,
	) {}

	// --- Reading state ---

	/** Snapshots newest first, each with a freshly computed display number. */
	async listSnapshots(noteId: string): Promise<SnapshotRow[]> {
		const manifest = await this.store.loadNoteManifest(noteId);
		if (!manifest) return [];
		const numbers = numberByAge(manifest.snapshots);
		return Object.entries(manifest.snapshots)
			.map(([snapshotId, meta]) => ({ snapshotId, ...meta, n: numbers.get(snapshotId)! }))
			.sort((a, b) => b.n - a.n);
	}

	async getManifest(noteId: string): Promise<NoteManifest | null> {
		return this.store.loadNoteManifest(noteId);
	}

	async readSnapshot(noteId: string, snapshotId: string): Promise<string | null> {
		return this.store.readSnapshot(noteId, snapshotId);
	}

	/**
	 * This is a cheap, text-only proxy for whether the working file matches a stored
	 * snapshot (rule R3) — it says nothing about attachments, so a changed-in-place
	 * attachment still reads as `clean` here.
	 *
	 * Used for: live display only — the History view's status badge (recomputed on
	 * every note edit while the view is open) and the save prompt's duplicate-of hint.
	 * Nothing with real stakes reads this; `getWorkingState` is the accurate check for
	 * that.
	 */
	async getProxyWorkingState(file: TFile): Promise<WorkingState> {
		const noteId = await this.identity.resolveNoteId(file);
		if (!noteId) return { kind: 'untracked' };
		const manifest = await this.store.loadNoteManifest(noteId);
		if (!manifest || Object.keys(manifest.snapshots).length === 0) return { kind: 'untracked' };

		const content = await this.readNoteContent(file);
		const matchIds = await this.findSnapshotIdsByNoteContent(manifest, content, await hashNoteContent(content));
		if (matchIds.length === 0) return { kind: 'unsaved' };
		return this.cleanState(manifest, matchIds[0]!);
	}

	/**
	 * This is whether the working file matches a stored snapshot (rule R3), text and
	 * attachments together — text matching snapshot X while X's attachments have
	 * since changed is real unsaved work, not a clean checkout of X. Checks every
	 * snapshot sharing the current text (see `findSnapshotIdsByNoteContent`), not just
	 * one: two snapshots can share identical text with different attachments, and the
	 * current attachments might match a twin other than the first one considered.
	 *
	 * Used for: the one decision with real stakes — whether `computeRestorePlan`'s rule R4
	 * automatic backup fires before a restore (`computeRestorePlan` is its only caller). Kept
	 * separate from `getProxyWorkingState` because that method also runs on every note
	 * edit while the History view is open, where hashing every embedded attachment
	 * would be needlessly expensive for a live display no decision depends on.
	 */
	async getWorkingState(file: TFile): Promise<WorkingState> {
		const noteId = await this.identity.resolveNoteId(file);
		if (!noteId) return { kind: 'untracked' };
		const manifest = await this.store.loadNoteManifest(noteId);
		if (!manifest || Object.keys(manifest.snapshots).length === 0) return { kind: 'untracked' };

		const content = await this.readNoteContent(file);
		const current = await captureAttachments(this.app, this.store, manifest.noteId, file.path, content, {
			dryRun: true,
			largeAttachmentThresholdBytes: this.getLargeAttachmentThresholdBytes(),
		});

		const candidateIds = await this.findSnapshotIdsByNoteContent(manifest, content, await hashNoteContent(content));
		for (const id of candidateIds) {
			if (this.hasSameAttachments(current, manifest.snapshots[id]?.attachments ?? [])) {
				return this.cleanState(manifest, id);
			}
		}
		return { kind: 'unsaved' };
	}

	/** Builds the `clean` verdict for a known-matching snapshot. Used by getProxyWorkingState and getWorkingState. */
	private cleanState(manifest: NoteManifest, snapshotId: string): WorkingState & { kind: 'clean' } {
		const meta = manifest.snapshots[snapshotId]!;
		return {
			kind: 'clean',
			snapshotId,
			n: numberByAge(manifest.snapshots).get(snapshotId)!,
			...(meta.name ? { name: meta.name } : {}),
		};
	}

	/**
	 * Whether `current` — a note's current attachments, as computed by `captureAttachments`
	 * with `dryRun: true` — are exactly the ones some snapshot's own `AttachmentRef[]`
	 * recorded.
	 *
	 * Compared position by position, not by matching names: this is only ever called once
	 * the note's text has already been confirmed byte-identical to the matched snapshot's
	 * (see `getWorkingState`), and `captureAttachments` extracts embeds by scanning that
	 * same text in document order — identical text guarantees identical embed order, so
	 * index `i` on one side is provably the same embed as index `i` on the other, with
	 * no need to match them up by name.
	 *
	 * Compared by size, plus hash unless the current ref's hash is the `''` "not computed"
	 * sentinel a dry run uses for a file at or above the configured large-attachment
	 * threshold, in which case size alone decides.
	 */
	private hasSameAttachments(current: AttachmentRef[], recorded: AttachmentRef[]): boolean {
		if (current.length !== recorded.length) return false;
		return current.every((fp, i) => {
			const ref = recorded[i]!;
			return ref.size === fp.size && (fp.hash === '' || ref.hash === fp.hash);
		});
	}

	// --- Saving a snapshot ---

	/**
	 * Captures the note's current content as a new snapshot, unconditionally — every
	 * explicit save records one, even if it is byte-identical to one already in the
	 * note's history, so an explicit request is never silently dropped.
	 */
	async saveSnapshot(file: TFile, name?: string, message?: string): Promise<SnapshotOutcome> {
		const noteId = await this.identity.resolveOrCreateNoteId(file);
		return this.queue.run(noteId, async () => {
			const content = await this.readNoteContent(file);
			const hash = await hashNoteContent(content);
			const manifest = (await this.store.loadNoteManifest(noteId)) ?? emptyNoteManifest(noteId, file.path);
			manifest.latestPath = file.path;

			const snapshotId = await this.createNewSnapshot(manifest, content, hash, file.path, name, message);
			await this.store.saveNoteManifest(manifest);
			return { row: this.toRow(manifest, snapshotId) };
		});
	}

	// --- Restoring (R1, R4) ---

	/**
	 * Inspects what a restore of `snapshotId` would touch beyond the note body: which
	 * of its embedded attachments still exist but have since changed, and whether each
	 * changed file's current bytes survive somewhere. Reads only — changes nothing.
	 */
	async computeRestorePlan(file: TFile, snapshotId: string): Promise<RestorePlan> {
		const noteId = await this.identity.resolveNoteId(file);
		if (!noteId) throw new Error('This note has no snapshot history.');
		const manifest = await this.store.loadNoteManifest(noteId);
		const target = manifest?.snapshots[snapshotId];
		if (!manifest || !target) throw new Error('That snapshot no longer exists.');

		let workingState: WorkingState | null = null;
		try {
			workingState = await this.getWorkingState(file);
		} catch (error) {
			console.error('Note Snapshots: could not read the working state before restore.', error);
		}

		let attachmentChanges: AttachmentChange[] = [];
		const attachmentsToRecreate: string[] = [];
		const attachmentsToOverwriteAndCaptured: string[] = [];
		const attachmentsToOverwriteAndUncaptured: string[] = [];
		const attachmentsAssumedUnchanged: string[] = [];
		try {
			attachmentChanges = await planAttachmentChanges(this.app, target, file.path, this.getLargeAttachmentThresholdBytes());
			for (const entry of attachmentChanges) {
				if (entry.disposition === 'missing') {
					attachmentsToRecreate.push(entry.name);
					continue;
				}
				if (entry.disposition === 'assumedUnchanged') {
					attachmentsAssumedUnchanged.push(entry.name);
					continue;
				}
				if (hasSnapshotWithAttachment(manifest, entry.currentHash!)) {
					attachmentsToOverwriteAndCaptured.push(entry.name);
				} else {
					attachmentsToOverwriteAndUncaptured.push(entry.name);
				}
			}
		} catch (error) {
			console.error('Note Snapshots: could not inspect attachments before restore.', error);
		}

		return {
			target: this.toRow(manifest, snapshotId),
			workingState,
			attachmentChanges,
			attachmentsToRecreate,
			attachmentsToOverwriteAndCaptured,
			attachmentsToOverwriteAndUncaptured,
			attachmentsAssumedUnchanged,
		};
	}

	/**
	 * Checks the note out to a stored snapshot, resolving any changed attachment per
	 * `attachments`.
	 *
	 * Rule R1: this creates nothing, unless rule R4 applies — there is unsaved work
	 * that matches no stored snapshot — in which case it is backed up first. Pass
	 * `dropUnsavedWork: true` to opt out of that backup and let the unsaved note text
	 * go instead; this is independent of `attachments`, which the caller decides
	 * separately (a restore can discard unsaved text with no attachment involved at
	 * all, e.g. when the target snapshot has none).
	 *
	 * Executes against `plan` directly rather than re-inspecting the vault — see
	 * `RestorePlan`'s own doc comment for why.
	 */
	async restoreSnapshot(
		file: TFile,
		plan: RestorePlan,
		options: { attachments?: AttachmentConflictMode; dropUnsavedWork?: boolean; backupName?: string } = {},
	): Promise<RestoreOutcome> {
		const noteId = await this.identity.resolveNoteId(file);
		if (!noteId) throw new Error('This note has no snapshot history.');
		return this.executeRestorePlan(file, noteId, plan, {
			forceBackup: false,
			dropUnsavedWork: options.dropUnsavedWork ?? false,
			overwriteMode: options.attachments ?? 'skip',
			backupName: options.backupName ?? UNSAVED_LABEL,
		});
	}

	/**
	 * Checks the note out to a stored snapshot, but backs up the current state first,
	 * unconditionally, then overwrites every changed attachment regardless of whether
	 * its current bytes exist anywhere else — this is the method the UI reaches for
	 * once the user has already been shown, and accepted, that some of those files
	 * would otherwise be lost.
	 *
	 * The backup captures every attachment the note's *current* content still embeds,
	 * so those are always safely recoverable by the time they're overwritten. It does
	 * not capture an attachment the target snapshot references but current content has
	 * already dropped — that one is overwritten too, but genuinely gone for good (see
	 * the README's Limitations for why, and `RestoreOutcome.attachmentsOverwrittenAndUnrecoverable`
	 * for how that's reported).
	 *
	 * Executes against `plan` directly — see `RestorePlan`'s own doc comment for why.
	 */
	async backupAndRestoreSnapshot(file: TFile, plan: RestorePlan, backupName?: string): Promise<RestoreOutcome> {
		const noteId = await this.identity.resolveNoteId(file);
		if (!noteId) throw new Error('This note has no snapshot history.');
		return this.executeRestorePlan(file, noteId, plan, {
			forceBackup: true,
			dropUnsavedWork: false,
			overwriteMode: 'replace',
			backupName: backupName ?? UNSAVED_LABEL,
		});
	}

	/**
	 * Writes the target snapshot's content to the note, backing up the current state
	 * first when the decision calls for it, then reconciles attachments.
	 *
	 * Shared by restoreSnapshot and backupAndRestoreSnapshot. Caller resolves noteId
	 * first so both can throw the same "no history" error before opening the queue.
	 * Takes an already-resolved decision, not raw options to interpret: by the time
	 * this runs, both callers already know whether to force a backup and how to treat a
	 * changed attachment; `overwriteMode` passes straight through to `restoreAttachments`
	 * unexamined, this function never branches on its value.
	 */
	private async executeRestorePlan(
		file: TFile,
		noteId: string,
		plan: RestorePlan,
		decision: { forceBackup: boolean; dropUnsavedWork: boolean; overwriteMode: AttachmentConflictMode; backupName: string },
	): Promise<RestoreOutcome> {
		const snapshotId = plan.target.snapshotId;
		return this.queue.run(noteId, async () => {
			const manifest = await this.store.loadNoteManifest(noteId);
			const target = manifest?.snapshots[snapshotId];
			if (!manifest || !target) throw new Error('That snapshot no longer exists.');

			const targetContent = await this.store.readSnapshot(noteId, snapshotId);
			if (targetContent === null) {
				throw new Error('That snapshot’s content is missing from the store.');
			}

			const current = await this.readNoteContent(file);
			let backupId: string | null = null;

			// "Confirm before restoring = Never" restores with no dialog at all, so there is
			// no dropUnsavedWork decision from the user — this check is what still protects
			// genuinely unsaved work there. A `null` plan.workingState (computation failed at
			// plan time) is treated as `unsaved` — guessing wrong costs one harmless extra
			// backup, guessing "clean" could lose work.
			const mightBeUnsaved = plan.workingState === null || plan.workingState.kind === 'unsaved';
			if (decision.forceBackup || (mightBeUnsaved && !decision.dropUnsavedWork)) {
				const hash = await hashNoteContent(current);
				backupId = await this.createNewSnapshot(manifest, current, hash, file.path, decision.backupName);
			}

			await this.app.vault.modify(file, targetContent);
			// `restoreAttachments` checks recoverability against `manifest` itself — the
			// copy already loaded above, not re-fetched — since that check only affects
			// how the outcome notice labels an overwrite, never whether it happens.
			const attachments = await restoreAttachments(
				this.app,
				this.store,
				noteId,
				plan.attachmentChanges,
				decision.overwriteMode,
				manifest,
			);
			manifest.activeSnapshotId = snapshotId;
			manifest.latestPath = file.path;
			await this.store.saveNoteManifest(manifest);

			return {
				restored: this.toRow(manifest, snapshotId),
				backup: backupId ? this.toRow(manifest, backupId) : null,
				attachmentsRecreated: attachments.recreated,
				attachmentsOverwrittenAndRecoverable: attachments.replacedAndRecoverable.map((entry) => entry.name),
				attachmentsOverwrittenAndUnrecoverable: attachments.replacedAndNotRecoverable,
				attachmentsSkipped: attachments.skipped,
			};
		});
	}

	// --- Deleting ---

	async removeSnapshot(noteId: string, snapshotId: string): Promise<void> {
		await this.queue.run(noteId, async () => {
			const manifest = await this.store.loadNoteManifest(noteId);
			const meta = manifest?.snapshots[snapshotId];
			if (!manifest || !meta) return;
			if (meta.locked) throw new Error('This snapshot is locked. Unlock it before deleting.');
			await this.store.removeSnapshot(noteId, snapshotId);
			delete manifest.snapshots[snapshotId];
			if (manifest.activeSnapshotId === snapshotId) manifest.activeSnapshotId = null;
			await this.gcAttachments(manifest, [meta]);
			await this.store.saveNoteManifest(manifest);
		});
	}

	/** Drops every unlocked snapshot of a note, leaving locked snapshots and the note itself untouched. */
	async removeAllSnapshots(noteId: string): Promise<{ removed: number; kept: number }> {
		return this.queue.run(noteId, async () => {
			const manifest = await this.store.loadNoteManifest(noteId);
			if (!manifest) return { removed: 0, kept: 0 };

			let removed = 0;
			let kept = 0;
			const removedMetas: SnapshotMetadata[] = [];
			for (const [snapshotId, meta] of Object.entries(manifest.snapshots)) {
				if (meta.locked) {
					kept++;
					continue;
				}
				await this.store.removeSnapshot(noteId, snapshotId);
				delete manifest.snapshots[snapshotId];
				removedMetas.push(meta);
				removed++;
			}
			if (manifest.activeSnapshotId && !manifest.snapshots[manifest.activeSnapshotId]) manifest.activeSnapshotId = null;
			await this.gcAttachments(manifest, removedMetas);
			await this.store.saveNoteManifest(manifest);
			return { removed, kept };
		});
	}

	// --- Editing metadata ---

	/** Locks or unlocks a snapshot, protecting it from deletion (single and bulk). */
	async setSnapshotLocked(noteId: string, snapshotId: string, locked: boolean): Promise<void> {
		await this.queue.run(noteId, async () => {
			const manifest = await this.store.loadNoteManifest(noteId);
			const meta = manifest?.snapshots[snapshotId];
			if (!manifest || !meta) return;
			if (locked) meta.locked = true;
			else delete meta.locked;
			await this.store.saveNoteManifest(manifest);
		});
	}

	/** Updates a snapshot's label and note together. An empty string clears that field. */
	async annotateSnapshot(noteId: string, snapshotId: string, name: string, message: string): Promise<void> {
		await this.queue.run(noteId, async () => {
			const manifest = await this.store.loadNoteManifest(noteId);
			const meta = manifest?.snapshots[snapshotId];
			if (!manifest || !meta) return;
			const trimmedName = name.trim();
			if (trimmedName.length > 0) meta.name = trimmedName;
			else delete meta.name;
			const trimmedMessage = message.trim();
			if (trimmedMessage.length > 0) meta.message = trimmedMessage;
			else delete meta.message;
			await this.store.saveNoteManifest(manifest);
		});
	}

	// --- Shared internals ---
	// Private helpers reused across the groups above. Ordered so each depends only
	// on what is defined before it.

	/** A display row for one snapshot, numbered against whatever snapshots exist now. Caller guarantees it exists. Used by listSnapshots, saveSnapshot, computeRestorePlan, and restoreSnapshot. */
	private toRow(manifest: NoteManifest, snapshotId: string): SnapshotRow {
		return { snapshotId, ...manifest.snapshots[snapshotId]!, n: numberByAge(manifest.snapshots).get(snapshotId)! };
	}

	/**
	 * Every snapshot holding exactly this content — usually at most one, but text alone
	 * doesn't pin down a single snapshot: two snapshots can share byte-identical text
	 * while differing only in their attachments.
	 *
	 * The hash only narrows the candidates; equality is always confirmed by comparing
	 * the stored bytes, so a weak fallback hash can never cause a wrong match.
	 *
	 * Ordered for the most useful "first result", since both callers just take
	 * whichever id they land on first (`getProxyWorkingState`, and `getWorkingState`
	 * picking the first result that also matches attachments):
	 *
	 *  - `activeSnapshotId` first, when it's among the matches — the checked-out
	 *    snapshot wins over any other twin.
	 *  - Otherwise, newest first.
	 */
	private async findSnapshotIdsByNoteContent(manifest: NoteManifest, content: string, hash: string): Promise<string[]> {
		const entries = Object.entries(manifest.snapshots);
		let candidates = entries.filter(([, meta]) => meta.hash === hash);

		if (candidates.length === 0) {
			// Hashes written by a different algorithm say nothing about equality, so
			// those have to be compared by content.
			candidates = entries.filter(([, meta]) => algorithmsDiffer(meta.hash, hash));
			if (candidates.length === 0) return [];
		}

		// Try the checked-out snapshot first, so identical-content twins resolve to the
		// one the user is on (last restored, or just saved) rather than whichever is
		// newest. The rest are newest first.
		let ids = candidates.map(([id]) => id).sort((a, b) => manifest.snapshots[b]!.ts.localeCompare(manifest.snapshots[a]!.ts));
		if (manifest.activeSnapshotId && ids.includes(manifest.activeSnapshotId)) {
			ids = [manifest.activeSnapshotId, ...ids.filter((id) => id !== manifest.activeSnapshotId)];
		}

		const matches: string[] = [];
		for (const id of ids) {
			const stored = await this.store.readSnapshot(manifest.noteId, id);
			if (stored === content) matches.push(id);
		}
		return matches;
	}

	/** Writes content as a new snapshot, points `activeSnapshotId` at it, and returns its id. Caller runs inside the note's queue. Used by saveSnapshot and restoreSnapshot. */
	private async createNewSnapshot(
		manifest: NoteManifest,
		content: string,
		hash: string,
		notePath: string,
		name?: string,
		message?: string,
	): Promise<string> {
		const snapshotId = newSnapshotId();
		const size = await this.store.writeSnapshot(manifest.noteId, snapshotId, content);
		const meta: SnapshotMetadata = {
			ts: monotonicTimestamp(manifest.snapshots),
			hash,
			size,
		};
		const trimmed = name?.trim();
		if (trimmed) meta.name = trimmed;
		const note = message?.trim();
		if (note) meta.message = note;
		// The note's full path at capture time: a display hint in the history, and the
		// reference point for placing recreated attachments (§2b). Not identity, and
		// not compared for dedup — a rename or move is not itself a new snapshot.
		if (notePath) meta.path = notePath;
		// Lineage only. There is no branching UI, but this makes it recoverable later.
		if (manifest.activeSnapshotId) meta.parent = manifest.activeSnapshotId;

		const attachments = await captureAttachments(this.app, this.store, manifest.noteId, notePath, content);
		if (attachments.length > 0) meta.attachments = attachments;

		manifest.snapshots[snapshotId] = meta;
		manifest.activeSnapshotId = snapshotId;
		return snapshotId;
	}

	/** Removes attachment blobs orphaned by a snapshot removal, unless another snapshot still needs them. Used by removeSnapshot and removeAllSnapshots. */
	private async gcAttachments(manifest: NoteManifest, removedMetas: SnapshotMetadata[]): Promise<void> {
		const removedHashes = new Set<string>();
		for (const meta of removedMetas) {
			for (const ref of meta.attachments ?? []) removedHashes.add(ref.hash);
		}
		if (removedHashes.size === 0) return;

		const stillReferenced = new Set<string>();
		for (const meta of Object.values(manifest.snapshots)) {
			for (const ref of meta.attachments ?? []) stillReferenced.add(ref.hash);
		}

		for (const hash of removedHashes) {
			if (!stillReferenced.has(hash)) await this.store.removeAttachment(manifest.noteId, hash);
		}
	}
}

// --- Module-level private helpers ---

/** A fresh manifest for a note that has no history yet. */
function emptyNoteManifest(noteId: string, latestPath: string): NoteManifest {
	return {
		schemaVersion: SCHEMA_VERSION,
		noteId,
		latestPath,
		createdAt: new Date().toISOString(),
		activeSnapshotId: null,
		snapshots: {},
	};
}

/**
 * Positions every snapshot by age, oldest = 1, so the newest snapshot carries the
 * highest number. Timestamps are strictly increasing (see monotonicTimestamp), so
 * this order matches creation order.
 *
 * Purely for display — deleting a snapshot shifts the rest, which is the point.
 */
function numberByAge(snapshots: Record<string, SnapshotMetadata>): Map<string, number> {
	const numbers = new Map<string, number>();
	Object.entries(snapshots)
		.sort(([, a], [, b]) => a.ts.localeCompare(b.ts))
		.forEach(([id], index) => numbers.set(id, index + 1));
	return numbers;
}

/**
 * Generates a new snapshot id.
 *
 * Only needs to be unique within one note's own history, not vault-wide like a
 * noteId, so it skips UUID-grade entropy. The timestamp prefix is also a minor
 * courtesy: filenames in the store sort chronologically under a plain listing.
 */
function newSnapshotId(): string {
	const random = Array.from({ length: 6 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
	return `${Date.now().toString(36)}-${random}`;
}

/**
 * The current time as a UTC ISO string for a new snapshot, clamped to always sort
 * after every snapshot already in the manifest.
 *
 * A backwards clock — an NTP correction, a manual change — would otherwise let a new
 * snapshot sort as older than one it followed. The stored time is nudged forward by
 * at most the size of that skew; ordering wins over a few milliseconds of drift in
 * the label.
 */
function monotonicTimestamp(snapshots: Record<string, SnapshotMetadata>): string {
	let latest = 0;
	for (const meta of Object.values(snapshots)) {
		const parsed = Date.parse(meta.ts);
		if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
	}
	return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

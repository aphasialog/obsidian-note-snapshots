import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
import type { SnapshotRow, WorkingState } from '@/types';
import { DEFAULT_SETTINGS, normaliseSettings, shouldConfirmRestore, type NoteSnapshotsSettings } from '@/settings';
import { Paths } from '@/core/paths';
import { Store } from '@/core/store';
import { IdentityService } from '@/core/identity';
import { SnapshotService, UNSAVED_LABEL, type AttachmentConflictMode, type RestorePlan } from '@/core/snapshots';
import { TaskQueue } from '@/util/task-queue';
import { HistoryView, VIEW_TYPE_HISTORY } from '@/ui/history-view';
import { NoteSnapshotsSettingTab } from '@/ui/settings-tab';
import { ChoiceModal, ConfirmModal, SnapshotModal } from '@/ui/modals';
import {
	describeRestoreOutcome,
	formatAttachmentNames,
	restoreConfirmationMessage,
	suggestedSnapshotName,
	formatSnapshotLabel,
} from '@/ui/format';

/** What the user chose in response to a restore prompt: a plain restore, or one with a forced backup first. */
type RestoreDecision =
	| { kind: 'restore'; mode: AttachmentConflictMode; dropUnsavedWork: boolean }
	| { kind: 'backupAndRestore' };

export default class NoteSnapshotsPlugin extends Plugin {
	settings: NoteSnapshotsSettings = DEFAULT_SETTINGS;

	// Assigned in onload, before anything can reach them.
	paths!: Paths;
	store!: Store;
	identity!: IdentityService;
	snapshots!: SnapshotService;

	private queue!: TaskQueue;

	// --- Lifecycle ---

	override async onload(): Promise<void> {
		this.settings = normaliseSettings(await this.loadData());

		this.queue = new TaskQueue();
		this.paths = new Paths(() => this.settings.storeFolder);
		this.store = new Store(this.app, this.paths, this.queue);
		this.identity = new IdentityService(this.app, this.store, this.queue, (file) => {
			new Notice(`"${file.basename}" looks like a copy, so it starts a fresh snapshot history.`, 8000);
		});
		this.snapshots = new SnapshotService(
			this.app,
			this.store,
			this.identity,
			this.queue,
			(file) => this.readNoteContent(file),
		);

		this.registerView(VIEW_TYPE_HISTORY, (leaf: WorkspaceLeaf) => new HistoryView(leaf, this));
		this.addSettingTab(new NoteSnapshotsSettingTab(this.app, this));

		this.addRibbonIcon('history', 'Snapshot history', () => void this.revealView());
		this.registerCommands();
		this.registerVaultEvents();
		// The history of a deleted note is only ever removed when the user asks for it,
		// via the "Clean up history of deleted notes" command or the settings button —
		// nothing is purged automatically.
	}

	override onunload(): void {
		// Views are torn down by Obsidian; nothing else holds resources.
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'snapshot-named',
			name: 'Save a named snapshot of the current note',
			checkCallback: (checking) => {
				const file = this.getTrackableFile();
				if (checking) return file !== null;
				void this.snapshotWithPrompt(file);
				return true;
			},
		});

		this.addCommand({
			id: 'snapshot-quick',
			name: 'Save a snapshot of the current note',
			checkCallback: (checking) => {
				const file = this.getTrackableFile();
				if (checking) return file !== null;
				void this.snapshotFile(file);
				return true;
			},
		});

		this.addCommand({
			id: 'open-history',
			name: 'Open snapshot history',
			callback: () => void this.revealView(),
		});

		this.addCommand({
			id: 'purge-orphans',
			name: 'Clean up history of deleted notes',
			callback: () => {
				void this.purgeOrphans().then((removed) => {
					new Notice(
						removed === 0
							? 'Nothing to clean up.'
							: `Removed history for ${removed} deleted note${removed === 1 ? '' : 's'}.`,
					);
				});
			},
		});
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on('rename', (file) => {
				if (!(file instanceof TFile) || this.paths.isInternal(file.path)) return;
				void this.identity
					.handleRename(file)
					.catch((error: unknown) => console.error('Note Snapshots: rename failed.', error))
					.finally(() => this.refreshViews());
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!(file instanceof TFile) || this.paths.isInternal(file.path)) return;
				void this.identity
					.handleDelete(file.path)
					.catch((error: unknown) => console.error('Note Snapshots: delete failed.', error));
			}),
		);
	}

	/** The active file, if it is something this plugin can track. */
	private getTrackableFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') return null;
		return this.paths.isInternal(file.path) ? null : file;
	}

	// --- Settings ---

	async updateSettings(patch: Partial<NoteSnapshotsSettings>): Promise<void> {
		const pathChanged = patch.storeFolder !== undefined && patch.storeFolder.trim() !== this.settings.storeFolder;
		this.settings = normaliseSettings({ ...this.settings, ...patch });
		await this.saveData(this.settings);
		if (pathChanged) this.store.invalidate();
		this.refreshViews();
	}

	// --- Content access ---

	/**
	 * Reads what the user currently sees.
	 *
	 * `vault.read` returns the file on disk, and Obsidian flushes the editor buffer a
	 * second or two after the last keystroke. Snapshotting straight after typing would
	 * otherwise silently miss the most recent edits, so an open editor wins.
	 */
	async readNoteContent(file: TFile): Promise<string> {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				return view.editor.getValue();
			}
		}
		return this.app.vault.read(file);
	}

	// --- History view ---

	async revealView(): Promise<void> {
		const [existing] = this.app.workspace.getLeavesOfType(VIEW_TYPE_HISTORY);
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_HISTORY, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HISTORY)) {
			if (leaf.view instanceof HistoryView) void leaf.view.refresh();
		}
	}

	// --- Saving a snapshot ---

	async snapshotWithPrompt(file: TFile | null): Promise<void> {
		if (!this.requireFile(file)) return;
		// Only the name is prefilled — the user still confirms explicitly, so a
		// snapshot is never created without their say-so.
		const suggestion = suggestedSnapshotName(this.settings, { note: file.basename });
		// If this save would be a true no-op — text and attachments both already
		// captured by some snapshot — say so. The user can still save an identical
		// snapshot from here, they just do it knowingly.
		const working = await this.getWorkingStateOrNull(file);
		const duplicateOf = working?.kind === 'clean' ? formatSnapshotLabel(working.n, working.name) : null;
		const entered = await new Promise<{ name: string; message: string } | null>((resolve) =>
			new SnapshotModal(
				this.app,
				{
					title: 'Save snapshot',
					cta: 'Save',
					namePlaceholder: 'Optional name',
					...(suggestion ? { initialName: suggestion } : {}),
					...(duplicateOf ? { notice: `The current content is identical to ${duplicateOf}.` } : {}),
				},
				resolve,
			).open(),
		);
		if (entered === null) return;
		await this.snapshotFile(file, entered.name, entered.message);
	}

	/**
	 * Saves a snapshot of `file`. Every user-invoked save — the sidebar button, the
	 * command, the header menu — records one even when the content is identical to an
	 * existing snapshot, so an explicit request is never silently dropped.
	 *
	 * Only restore's automatic backup (rule R4) keeps the no-op.
	 */
	async snapshotFile(file: TFile | null, name?: string, message?: string): Promise<void> {
		if (!this.requireFile(file)) return;
		try {
			const { row } = await this.snapshots.saveSnapshot(file, name, message);
			new Notice(`Saved ${formatSnapshotLabel(row.n, row.name)}.`);
			this.refreshViews();
		} catch (error) {
			this.reportError('Could not save a snapshot', error);
		}
	}

	// --- Restoring a snapshot ---

	async restoreSnapshot(file: TFile | null, row: SnapshotRow): Promise<void> {
		if (!this.requireFile(file)) return;

		let plan: RestorePlan;
		try {
			plan = await this.snapshots.computeRestorePlan(file, row.snapshotId);
		} catch (error) {
			this.reportError('Could not restore that snapshot', error);
			return;
		}

		const decision = await this.decideRestore(file, row, plan);
		if (decision === null) return;

		// The user's own naming preset, carried over so an automatic backup reads like
		// one of their own snapshots instead of always the same generic label.
		const suggestion = suggestedSnapshotName(this.settings, { note: file.basename });
		const backupName = suggestion ? `${suggestion} - ${UNSAVED_LABEL}` : UNSAVED_LABEL;

		try {
			const outcome =
				decision.kind === 'backupAndRestore'
					? await this.snapshots.backupAndRestoreSnapshot(file, plan, backupName)
					: await this.snapshots.restoreSnapshot(file, plan, {
							attachments: decision.mode,
							dropUnsavedWork: decision.dropUnsavedWork,
							backupName,
						});
			// backupAndRestoreSnapshot always yields outcome.backup, which describeRestoreOutcome
			// checks before ever looking at mode — so the exact value here does not matter.
			const noticeMode = decision.kind === 'backupAndRestore' ? 'replace' : decision.mode;
			new Notice(describeRestoreOutcome(outcome, noticeMode));
			if (outcome.attachmentsOverwrittenAndRecoverable.length > 0 || outcome.attachmentsOverwrittenAndUnrecoverable.length > 0 || outcome.attachmentsRecreated > 0) {
				this.reloadEmbeds(file);
			}
			this.refreshViews();
		} catch (error) {
			this.reportError('Could not restore that snapshot', error);
		}
	}

	/**
	 * Settles how the restore should treat changed embedded attachments, prompting when
	 * something is at stake. Returns null if the user backs out.
	 *
	 * Two independent checks feed this, and the attachment one always runs first. So a
	 * restore can still prompt here even when `plan.workingState` reports "clean" —
	 * that's not a contradiction, `plan.workingState` only ever speaks to the note's
	 * text (see its own doc comment on `RestorePlan`).
	 */
	private async decideRestore(file: TFile, row: SnapshotRow, plan: RestorePlan): Promise<RestoreDecision | null> {
		const policy = this.settings.confirmRestore;

		// Case 1: policy is "never" — never interrupt, restore the text and leave
		// present attachments alone.
		if (policy === 'never') return { kind: 'restore', mode: 'skip', dropUnsavedWork: false };

		// Case 2: whenever restoring would overwrite an attachment — a separate question
		// from whether the current content is itself clean, so a clean workingState can
		// still land here; promptRestoreWithAttachmentsChange handles both via its own
		// clean/dirty branches.
		if (plan.attachmentsToOverwriteAndCaptured.length > 0 || plan.attachmentsToOverwriteAndUncaptured.length > 0) {
			return this.promptRestoreWithAttachmentsChange(row, plan);
		}

		// Case 3: nothing is at stake under this policy — restore straight away.
		if (!shouldConfirmRestore(policy, plan.workingState)) {
			return { kind: 'restore', mode: 'skip', dropUnsavedWork: false };
		}

		// Case 4: only the note text is at stake (no attachment change, per Case 2) and
		// it's unsaved — promptRestoreWithTextOnlyChange lets the user keep it (snapshot
		// first) or drop it, defaulting to keeping it.
		if (plan.workingState?.kind === 'unsaved') {
			return this.promptRestoreWithTextOnlyChange(row);
		}

		// Case 5: every other state — a plain yes/no confirm.
		const confirmed = await this.confirm({
			title: 'Restore snapshot',
			message: restoreConfirmationMessage(file.basename, row, plan.workingState),
			cta: 'Restore',
		});
		return confirmed ? { kind: 'restore', mode: 'skip', dropUnsavedWork: false } : null;
	}

	/** The multi-way prompt shown when a restore would overwrite a changed attachment. */
	private async promptRestoreWithAttachmentsChange(row: SnapshotRow, plan: RestorePlan): Promise<RestoreDecision | null> {
		const target = formatSnapshotLabel(row.n, row.name);
		// A null workingState (getWorkingState threw) is treated the same as 'unsaved' —
		// see executeRestorePlan's mightBeUnsaved for the same convention: unknown is not safe.
		const clean = plan.workingState?.kind === 'clean' ? plan.workingState : null;
		const atRisk = plan.attachmentsToOverwriteAndUncaptured.length > 0 || clean === null;
		const changedAttachments = plan.attachmentChanges.filter((change) => change.disposition === 'changed');
		const body: string[] = [];

		// 1. Conclusion: is the current content already safe, or would something be lost?
		// atRisk's OR includes clean === null, so atRisk false guarantees clean is set.
		body.push(
			atRisk
				? 'The current content has unsaved work.'
				: `The current content is identical to ${formatSnapshotLabel(clean!.n, clean!.name)}.`,
		);

		// 2. Details: exactly what restoring would overwrite, plus each attachment's path
		// so it can be checked before deciding.
		const overwritten: string[] = [];
		if (clean === null) overwritten.push('the note text');
		overwritten.push(changedAttachments.length === 1 ? 'the following attachment:' : 'the following attachments:');
		body.push(`This restore will overwrite ${overwritten.join(' and ')}`);
		const list = changedAttachments.map((change) => change.presentPath!);

		// Mention attachments too large to hash — same size as before, so assumed
		// unchanged without reading their content.
		if (plan.attachmentsAssumedUnchanged.length > 0) {
			const one = plan.attachmentsAssumedUnchanged.length === 1;
			body.push(`${formatAttachmentNames(plan.attachmentsAssumedUnchanged)} ${one ? 'is' : 'are'} the same size and assumed unchanged.`);
		}

		// Offer the choices, recommended action rightmost, and translate the pick back
		// into a decision.
		// The left button's label depends on which axis the two choices actually differ
		// on: atRisk contrasts backup vs. no backup (matching promptRestoreWithTextOnlyChange's
		// wording), while the clean branch contrasts touching attachments vs. not — nothing
		// is backed up either way there, so "text only" is the distinction worth naming.
		const choices = atRisk
			? [{ label: 'Restore only' }, { label: 'Snapshot & restore', cta: true }]
			: [{ label: 'Restore text only' }, { label: 'Restore & replace attachments', cta: true }];

		const index = await new Promise<number | null>((resolve) =>
			new ChoiceModal(this.app, { title: `Restore ${target}`, body, list, choices }, resolve).open(),
		);
		if (index === null) return null;
		// The body already told the user their current content has unsaved work (or is
		// safe), so "Restore only" here means what it says: no automatic backup, same as
		// promptRestoreWithTextOnlyChange's "Restore only". Harmless when already clean —
		// mightBeUnsaved is false there regardless of this flag.
		if (index === 0) return { kind: 'restore', mode: 'skip', dropUnsavedWork: true };
		return atRisk ? { kind: 'backupAndRestore' } : { kind: 'restore', mode: 'replace', dropUnsavedWork: false };
	}

	/**
	 * Restore over a note with unsaved work and no attachment at stake: keep the
	 * unsaved text as a backup snapshot first (the default), or discard it. Cancel
	 * backs out.
	 */
	private async promptRestoreWithTextOnlyChange(row: SnapshotRow): Promise<RestoreDecision | null> {
		const target = formatSnapshotLabel(row.n, row.name);
		const index = await new Promise<number | null>((resolve) =>
			new ChoiceModal(
				this.app,
				{
					title: `Restore ${target}`,
					body: [
						'The current content has unsaved work.',
						'This restore will overwrite the note.',
					],
					choices: [
						{ label: 'Restore only' },
						{ label: 'Snapshot & restore', cta: true },
					],
				},
				resolve,
			).open(),
		);
		if (index === null) return null;
		return index === 1
			? { kind: 'restore', mode: 'skip', dropUnsavedWork: false }
			: { kind: 'restore', mode: 'skip', dropUnsavedWork: true };
	}

	/**
	 * Refreshes every open pane showing `file` after a restore rewrote its embedded
	 * attachments.
	 *
	 * An image embed renders once to an `app://…/pic.png?<mtime>` URL and is not
	 * re-resolved while the pane stays open, so overwriting the file on disk leaves the
	 * stale picture on screen until the note is closed and reopened. `setViewState`
	 * with the leaf's own current state is a no-op — Obsidian sees the same view type
	 * and file and reuses the live view instance instead of rebuilding it. Swapping to
	 * the (harmless, built-in) `empty` view type first forces that reuse path to miss:
	 * the leaf tears the markdown view down, and switching back re-creates it from disk,
	 * so the embed is resolved afresh against the new bytes. `eState` carries the
	 * cursor/scroll position across the round trip. Covers Reading and Live Preview
	 * alike, since it rebuilds the pane itself rather than asking a specific render mode
	 * to redraw.
	 *
	 * Fixes this on desktop. On mobile it does not — `CapacitorAdapter.getResourcePath`
	 * has no cache-busting suffix, so the freshly rebuilt pane requests the exact same
	 * URL as before and the webview serves it from cache regardless. That is a platform
	 * limitation outside what a rebuild can reach; see the README's Limitations section.
	 */
	private reloadEmbeds(file: TFile): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== file.path) continue;
			const state = leaf.getViewState();
			const eState = leaf.getEphemeralState() as unknown;
			void leaf.setViewState({ type: 'empty' }).then(() => leaf.setViewState(state, eState));
		}
	}

	// --- Annotating, locking, deleting ---

	async annotateSnapshot(noteId: string | null, row: SnapshotRow): Promise<void> {
		if (!noteId) return;
		const entered = await new Promise<{ name: string; message: string } | null>((resolve) =>
			new SnapshotModal(
				this.app,
				{
					title: `Annotate ${formatSnapshotLabel(row.n, row.name)}`,
					cta: 'Save',
					namePlaceholder: 'Leave empty to remove the name',
					...(row.name === undefined ? {} : { initialName: row.name }),
					...(row.message === undefined ? {} : { initialMessage: row.message }),
				},
				resolve,
			).open(),
		);
		if (entered === null) return;
		try {
			await this.snapshots.annotateSnapshot(noteId, row.snapshotId, entered.name, entered.message);
			this.refreshViews();
		} catch (error) {
			this.reportError('Could not update that snapshot', error);
		}
	}

	async toggleLockSnapshot(noteId: string | null, row: SnapshotRow): Promise<void> {
		if (!noteId) return;
		try {
			await this.snapshots.setSnapshotLocked(noteId, row.snapshotId, !row.locked);
			new Notice(row.locked ? `Unlocked ${formatSnapshotLabel(row.n, row.name)}.` : `Locked ${formatSnapshotLabel(row.n, row.name)}.`);
			this.refreshViews();
		} catch (error) {
			this.reportError('Could not update the lock', error);
		}
	}

	async deleteSnapshot(noteId: string | null, row: SnapshotRow): Promise<void> {
		if (!noteId) return;

		if (row.locked) {
			new Notice(`${formatSnapshotLabel(row.n, row.name)} is locked. Unlock it before deleting.`);
			return;
		}

		if (this.settings.confirmDelete) {
			const confirmed = await this.confirm({
				title: 'Delete snapshot',
				message: `Permanently delete ${formatSnapshotLabel(row.n, row.name)}?`,
				cta: 'Delete',
				destructive: true,
			});
			if (!confirmed) return;
		}

		try {
			await this.snapshots.removeSnapshot(noteId, row.snapshotId);
			new Notice(`Deleted ${formatSnapshotLabel(row.n, row.name)}.`);
			this.refreshViews();
		} catch (error) {
			this.reportError('Could not delete that snapshot', error);
		}
	}

	async deleteAllSnapshots(noteId: string | null, file: TFile | null): Promise<void> {
		if (!noteId) return;
		const confirmed = await this.confirm({
			title: 'Delete all snapshots',
			message: `Permanently delete all snapshots of "${file?.basename ?? 'this note'}"? Locked snapshots are kept, and the note itself is not touched.`,
			cta: 'Delete all',
			destructive: true,
		});
		if (!confirmed) return;

		try {
			const { removed, kept } = await this.snapshots.removeAllSnapshots(noteId);
			new Notice(
				kept > 0
					? `Deleted ${removed} snapshot${removed === 1 ? '' : 's'}. ${kept} locked snapshot${kept === 1 ? '' : 's'} kept.`
					: 'Deleted all snapshots of this note.',
			);
			this.refreshViews();
		} catch (error) {
			this.reportError('Could not delete this note’s snapshots', error);
		}
	}

	// --- Cleaning up deleted notes ---

	async purgeOrphans(): Promise<number> {
		const days = this.settings.purgeOrphansAfterDays;
		if (days <= 0) return 0;
		try {
			return await this.identity.purgeOrphans(days);
		} catch (error) {
			this.reportError('Could not clean up deleted notes', error);
			return 0;
		}
	}

	// --- Shared internals ---

	/**
	 * The working state including attachments, or null when it could not be
	 * determined; callers treat that as "not safe". The accurate, attachment-aware
	 * `SnapshotService.getWorkingState` (not the cheap `getProxyWorkingState`), so
	 * `snapshotWithPrompt`'s duplicate notice only fires when saving now would be a
	 * true no-op — text and attachments both already captured — not merely when the
	 * text happens to match some other snapshot.
	 */
	private async getWorkingStateOrNull(file: TFile): Promise<WorkingState | null> {
		try {
			return await this.snapshots.getWorkingState(file);
		} catch (error) {
			console.error('Note Snapshots: could not read the working state.', error);
			return null;
		}
	}

	private requireFile(file: TFile | null): file is TFile {
		if (!file) {
			new Notice('Open a markdown note first.');
			return false;
		}
		return true;
	}

	private confirm(options: {
		title: string;
		message: string;
		cta: string;
		destructive?: boolean;
	}): Promise<boolean> {
		return new Promise((resolve) => new ConfirmModal(this.app, options, resolve).open());
	}

	private reportError(summary: string, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`Note Snapshots: ${summary}.`, error);
		new Notice(`${summary}: ${detail}`, 8000);
	}
}

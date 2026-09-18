import type { WorkingState } from '@/types';

/**
 * When to ask before a restore overwrites the note.
 *
 *  - `always`       — confirm every restore.
 *  - `when-unsaved` — confirm only when the restore would overwrite unsaved work: the
 *                     working file matches no snapshot, so it is backed up first rather
 *                     than the restore just moving `activeSnapshotId`.
 *  - `never`        — restore immediately.
 *
 * `when-unsaved` is judged by the accurate, attachment-aware check (see
 * `SnapshotService.getWorkingState`) — text matching some snapshot while its
 * attachments have since changed still counts as unsaved work here, not "clean".
 *
 * A changed embedded attachment gets its own, independent confirm-and-restore path
 * regardless of this policy's verdict on the note body: it's checked separately and
 * lazily, only once a restore is actually attempted, against the *target* snapshot's
 * own recorded attachments (`computeRestorePlan`, via `planAttachmentChanges`) — so it
 * fires on the ordinary case of restoring to a version whose attachments simply differ
 * from the current ones, not only when something is actually unsaved.
 *
 * That attachment check is still gated by this same policy, not a separate setting —
 * `decideRestore` gates it on the very same `never` above: `always` and `when-unsaved`
 * alike always confirm an attachment overwrite, and only `never` skips it too.
 */
export type RestoreConfirmPolicy = 'always' | 'when-unsaved' | 'never';

/** Which name the snapshot prompt starts with. */
export type SnapshotNameSuggestion = 'none' | 'date' | 'datetime' | 'custom';

export interface NoteSnapshotsSettings {
	/** Folder inside the vault that holds the snapshot store. */
	storeFolder: string;
	/** Days to keep the history of a deleted note. 0 keeps it forever. */
	purgeOrphansAfterDays: number;
	confirmRestore: RestoreConfirmPolicy;
	confirmDelete: boolean;
	/** Preset used to prefill the snapshot name prompt. */
	snapshotNameSuggestion: SnapshotNameSuggestion;
	/** Token template used when the preset is `custom`. */
	snapshotNameTemplate: string;
	/** Attachments at or above this size are checked for changes by size alone. 0 always checks content. */
	largeAttachmentThresholdMB: number;
}

export const DEFAULT_SETTINGS: NoteSnapshotsSettings = {
	storeFolder: '.note-snapshots',
	purgeOrphansAfterDays: 30,
	confirmRestore: 'when-unsaved',
	confirmDelete: true,
	snapshotNameSuggestion: 'none',
	snapshotNameTemplate: '{{date}} {{time}}',
	largeAttachmentThresholdMB: 25,
};

const RESTORE_POLICIES: readonly RestoreConfirmPolicy[] = ['always', 'when-unsaved', 'never'];
const NAME_SUGGESTIONS: readonly SnapshotNameSuggestion[] = ['none', 'date', 'datetime', 'custom'];

/** Coerces whatever is on disk into valid settings. */
export function normaliseSettings(raw: unknown): NoteSnapshotsSettings {
	const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<NoteSnapshotsSettings>;
	const path = typeof input.storeFolder === 'string' ? input.storeFolder.trim() : '';
	return {
		storeFolder: path.length > 0 ? path : DEFAULT_SETTINGS.storeFolder,
		purgeOrphansAfterDays: clampInt(
			input.purgeOrphansAfterDays,
			DEFAULT_SETTINGS.purgeOrphansAfterDays,
			0,
			3_650,
		),
		confirmRestore: normaliseRestorePolicy(input.confirmRestore),
		confirmDelete: input.confirmDelete ?? DEFAULT_SETTINGS.confirmDelete,
		largeAttachmentThresholdMB: clampInt(
			input.largeAttachmentThresholdMB,
			DEFAULT_SETTINGS.largeAttachmentThresholdMB,
			0,
			100_000,
		),
		snapshotNameSuggestion: oneOf(
			NAME_SUGGESTIONS,
			input.snapshotNameSuggestion,
			DEFAULT_SETTINGS.snapshotNameSuggestion,
		),
		// An empty string is a deliberate "suggest nothing", so it survives.
		snapshotNameTemplate:
			typeof input.snapshotNameTemplate === 'string'
				? input.snapshotNameTemplate
				: DEFAULT_SETTINGS.snapshotNameTemplate,
	};
}

/**
 * Whether a restore of `working` needs a confirmation under `policy`.
 *
 * A `clean` working file is the only provably safe case: its content is already in
 * the note's history, so the restore writes content that is recoverable either way
 * and creates nothing. Anything else — real unsaved work, or a state we could not
 * determine — is treated as worth asking about.
 */
export function shouldConfirmRestore(policy: RestoreConfirmPolicy, working: WorkingState | null): boolean {
	switch (policy) {
		case 'never':
			return false;
		case 'always':
			return true;
		case 'when-unsaved':
			return working?.kind !== 'clean';
	}
}

/** Migrates the pre-1.0 boolean form, where `true` meant "always ask". */
function normaliseRestorePolicy(value: unknown): RestoreConfirmPolicy {
	if (value === true) return 'always';
	if (value === false) return 'never';
	return oneOf(RESTORE_POLICIES, value, DEFAULT_SETTINGS.confirmRestore);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

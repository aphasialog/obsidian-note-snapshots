import type { SnapshotRow, WorkingState } from '@/types';
import type { AttachmentConflictMode, RestoreOutcome } from '@/core/snapshots';
import type { NoteSnapshotsSettings } from '@/settings';

// --- Snapshot names ---

/** "V3" or "V3 · Before refactor". */
export function formatSnapshotLabel(n: number, name?: string): string {
	return name ? `V${n} · ${name}` : `V${n}`;
}

/**
 * A short, quoted list of names: `"a.png"`, `"a.png" and "b.png"`,
 * `"a.png", "b.png" and "c.png"`, then `4 attachments` once it would run long.
 */
export function formatAttachmentNames(names: string[], max = 3): string {
	if (names.length === 0) return 'no attachments';
	if (names.length > max) return `${names.length} attachments`;
	const quoted = names.map((name) => `"${name}"`);
	if (quoted.length === 1) return quoted[0]!;
	return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]!}`;
}

// --- Restore messaging ---

/**
 * What the restore confirmation says, tailored to what the restore will actually do.
 *
 * A `clean` working file is the only case worth distinguishing: its content is
 * identical to some snapshot, so restoring risks nothing. Every other case —
 * unsaved work, or a state we could not determine — gets the same message, since both
 * are resolved the same way: whatever is unsaved is captured first.
 */
export function restoreConfirmationMessage(basename: string, row: SnapshotRow, working: WorkingState | null): string {
	const target = formatSnapshotLabel(row.n, row.name);

	if (working?.kind === 'clean') {
		if (working.snapshotId === row.snapshotId) {
			return `"${basename}" is identical to ${target}, so restoring changes nothing.`;
		}
		return `Replace the contents of "${basename}" with ${target}? The current content is identical to ${formatSnapshotLabel(working.n, working.name)}.`;
	}

	return `Replace the contents of "${basename}" with ${target}? Any unsaved work can be captured first.`;
}

/** The single notice shown after a restore, covering the body and every attachment it touched. */
export function describeRestoreOutcome(outcome: RestoreOutcome, mode: AttachmentConflictMode): string {
	const restored = formatSnapshotLabel(outcome.restored.n, outcome.restored.name);
	const parts: string[] = [];

	if (outcome.backup) {
		const backup = formatSnapshotLabel(outcome.backup.n, outcome.backup.name);
		parts.push(`Saved the previous state as ${backup}, then restored ${restored}.`);
	} else if (mode === 'skip' && outcome.attachmentsSkipped.length > 0) {
		parts.push(`Restored ${restored}'s text.`);
	} else {
		parts.push(`Restored ${restored}.`);
	}

	if (outcome.attachmentsRecreated > 0) {
		const count = outcome.attachmentsRecreated;
		parts.push(`Recreated ${count} missing attachment${count === 1 ? '' : 's'}.`);
	}

	if (outcome.attachmentsOverwrittenAndRecoverable.length > 0) {
		parts.push(describeReplaced(outcome.attachmentsOverwrittenAndRecoverable));
	}

	if (outcome.attachmentsOverwrittenAndUnrecoverable.length > 0) {
		parts.push(describeDiscarded(outcome.attachmentsOverwrittenAndUnrecoverable));
	}

	if (outcome.attachmentsSkipped.length > 0) {
		const plural = outcome.attachmentsSkipped.length !== 1;
		parts.push(`${formatAttachmentNames(outcome.attachmentsSkipped)} still show${plural ? '' : 's'} a later version.`);
	}

	return parts.join(' ');
}

/** "Replaced …" */
function describeReplaced(replaced: string[]): string {
	return `Replaced ${formatAttachmentNames(replaced)}.`;
}

/** "Discarded the current copy of …" */
function describeDiscarded(discarded: string[]): string {
	return `Discarded the current copy of ${formatAttachmentNames(discarded)}.`;
}

// --- Byte and time formatting ---

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAbsolute(iso: string): string {
	const then = new Date(iso);
	return Number.isNaN(then.getTime()) ? iso : then.toLocaleString();
}

// --- Snapshot name templates ---

const TOKEN = /\{\{\s*(\w+)\s*\}\}/g;

/** What a snapshot name template can interpolate. */
export interface NameContext {
	/** The note's basename, without the extension. */
	note: string;
	/** Defaults to now; injectable so the checks are deterministic. */
	now?: Date;
}

/**
 * Fills `{{token}}` placeholders in a snapshot name template.
 *
 * Unknown tokens are left verbatim rather than blanked, so a typo is visible in the
 * prompt instead of silently producing a shorter name.
 */
export function renderNameTemplate(template: string, context: NameContext): string {
	const now = context.now ?? new Date();
	return template
		.replace(TOKEN, (match, token: string) => {
			switch (token.toLowerCase()) {
				case 'date':
					return dateToken(now);
				case 'time':
					return timeToken(now);
				case 'datetime':
					return `${dateToken(now)} ${timeToken(now)}`;
				case 'timestamp':
					return String(now.getTime());
				case 'iso':
					return now.toISOString();
				case 'note':
					return context.note;
				default:
					return match;
			}
		})
		.trim();
}

/** The name the snapshot prompt should open with, or '' for an empty box. */
export function suggestedSnapshotName(settings: NoteSnapshotsSettings, context: NameContext): string {
	return renderNameTemplate(suggestionTemplate(settings), context);
}

/** The template behind a suggestion preset. `custom` supplies its own. */
function suggestionTemplate(settings: NoteSnapshotsSettings): string {
	switch (settings.snapshotNameSuggestion) {
		case 'none':
			return '';
		case 'date':
			return '{{date}}';
		case 'datetime':
			return '{{datetime}}';
		case 'custom':
			return settings.snapshotNameTemplate;
	}
}

function dateToken(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeToken(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

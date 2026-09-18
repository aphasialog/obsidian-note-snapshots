import { IdentityService } from '../src/core/identity';
import { Paths } from '../src/core/paths';
import { Store } from '../src/core/store';
import { UNSAVED_LABEL, SnapshotService, type AttachmentConflictMode } from '../src/core/snapshots';
import { DEFAULT_SETTINGS, normaliseSettings, shouldConfirmRestore, type NoteSnapshotsSettings } from '../src/settings';
import {
	describeRestoreOutcome,
	renderNameTemplate,
	restoreConfirmationMessage,
	suggestedSnapshotName,
} from '../src/ui/format';
import type { RestoreOutcome } from '../src/core/snapshots';
import { buildDiffRows } from '../src/ui/diff';
import { TaskQueue } from '../src/util/task-queue';
import { FakeVault } from './fake-vault';
import type { TFile } from './stubs/obsidian';

// The core layer reads the ambient `activeWindow` Obsidian sets up in every real
// window (main or popout) rather than `window` directly, per Obsidian's own plugin
// guidance. Node has neither, so stand in the same way Obsidian itself does: point it
// at the global scope, which already carries Node's native `crypto`.
(globalThis as { activeWindow?: typeof globalThis }).activeWindow = globalThis;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
	if (condition) {
		passed++;
		console.log(`  ok   ${label}`);
	} else {
		failed++;
		console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

function equal(label: string, actual: unknown, expected: unknown): void {
	check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

interface Harness {
	vault: FakeVault;
	snapshots: SnapshotService;
	identity: IdentityService;
	settings: NoteSnapshotsSettings;
}

function harness(overrides: Partial<NoteSnapshotsSettings> = {}): Harness {
	const vault = new FakeVault();
	const settings: NoteSnapshotsSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const queue = new TaskQueue();
	const paths = new Paths(() => settings.storeFolder);
	const store = new Store(vault.app, paths, queue);
	const identity = new IdentityService(vault.app, store, queue);
	const snapshots = new SnapshotService(
		vault.app,
		store,
		identity,
		queue,
		(file) => vault.app.vault.read(file),
		() => settings.largeAttachmentThresholdMB * 1024 * 1024,
	);
	return { vault, snapshots, identity, settings };
}

/** Note body without the frontmatter the plugin stamps in. */
function body(vault: FakeVault, file: TFile): string {
	return (vault.disk.get(file.path) ?? '').replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** computeRestorePlan then restoreSnapshot, matching how the real caller (main.ts) always uses them together. */
async function restore(
	snapshots: SnapshotService,
	file: TFile,
	snapshotId: string,
	options?: { attachments?: AttachmentConflictMode; dropUnsavedWork?: boolean },
): Promise<RestoreOutcome> {
	const plan = await snapshots.computeRestorePlan(file, snapshotId);
	return snapshots.restoreSnapshot(file, plan, options);
}

/** computeRestorePlan then backupAndRestoreSnapshot. */
async function backupAndRestore(snapshots: SnapshotService, file: TFile, snapshotId: string): Promise<RestoreOutcome> {
	const plan = await snapshots.computeRestorePlan(file, snapshotId);
	return snapshots.backupAndRestoreSnapshot(file, plan);
}

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
	console.log(`\n${name}`);
	try {
		await run();
	} catch (error) {
		failed++;
		console.log(`  FAIL threw — ${error instanceof Error ? error.stack : String(error)}`);
	}
}

// ---------------------------------------------------------------------------

await scenario('R1: flipping between two snapshots 50 times creates nothing', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Toggle.md', 'A\n');

	const v1 = await snapshots.saveSnapshot(file, 'A');
	await vault.app.vault.modify(file, `---\nns-id: ${await identity.resolveNoteId(file)}\n---\nB\n`);
	const v2 = await snapshots.saveSnapshot(file, 'B');

	const noteId = (await identity.resolveNoteId(file))!;
	equal('two snapshots to start', (await snapshots.listSnapshots(noteId)).length, 2);

	for (let i = 0; i < 50; i++) {
		await restore(snapshots, file, v1.row.snapshotId);
		await restore(snapshots, file, v2.row.snapshotId);
	}

	const rows = await snapshots.listSnapshots(noteId);
	equal('still exactly two snapshots after 100 restores', rows.length, 2);
	equal('no backup snapshots were created', rows.filter((row) => row.name === UNSAVED_LABEL).length, 0);
	equal('content is the last restored snapshot', body(vault, file), 'B\n');

	const manifest = await snapshots.getManifest(noteId);
	equal('activeSnapshotId tracks the checked-out snapshot', manifest?.activeSnapshotId, v2.row.snapshotId);

	const state = await snapshots.getWorkingState(file);
	equal('working state is clean', state.kind, 'clean');
});

await scenario('R4: genuine unsaved work is captured exactly once', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Unsaved.md', 'A\n');
	const v1 = await snapshots.saveSnapshot(file, 'A');
	const noteId = (await identity.resolveNoteId(file))!;

	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nB\n`);
	equal('unsaved edit is detected', (await snapshots.getWorkingState(file)).kind, 'unsaved');

	const restored = await restore(snapshots, file, v1.row.snapshotId);
	check('a backup was taken', restored.backup !== null);
	equal('the backup is labelled', restored.backup?.name, UNSAVED_LABEL);
	equal('two snapshots now exist', (await snapshots.listSnapshots(noteId)).length, 2);

	// Flipping between the two from here on must stay flat.
	for (let i = 0; i < 10; i++) {
		await restore(snapshots, file, restored.backup!.snapshotId);
		await restore(snapshots, file, v1.row.snapshotId);
	}
	equal('no further growth', (await snapshots.listSnapshots(noteId)).length, 2);
});

await scenario('Restore: dropUnsavedWork discards unsaved work instead of backing it up', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Discard.md', 'A\n');
	const v1 = await snapshots.saveSnapshot(file, 'A');
	const noteId = (await identity.resolveNoteId(file))!;

	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nB\n`);
	equal('unsaved edit is detected', (await snapshots.getWorkingState(file)).kind, 'unsaved');

	const restored = await restore(snapshots, file, v1.row.snapshotId, { dropUnsavedWork: true });
	check('no backup was taken', restored.backup === null);
	equal('still just the one snapshot', (await snapshots.listSnapshots(noteId)).length, 1);
	equal('the working file matches the restored snapshot', (await snapshots.getWorkingState(file)).kind, 'clean');
});

await scenario('No retention: every save keeps growing the history, nothing is ever reclaimed automatically', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Grow.md', 'v0\n');
	const noteId = await (async () => {
		await snapshots.saveSnapshot(file, 'first');
		return (await identity.resolveNoteId(file))!;
	})();

	for (let i = 1; i <= 6; i++) {
		await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nv${i}\n`);
		await snapshots.saveSnapshot(file);
	}

	const rows = await snapshots.listSnapshots(noteId);
	equal('nothing was reclaimed, every save is kept', rows.length, 7);
});

await scenario('§4 rename: history survives a move', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Old.md', 'text\n');
	await snapshots.saveSnapshot(file, 'before move');
	const before = (await identity.resolveNoteId(file))!;

	vault.renameNote(file, 'Folder/New.md');
	await identity.handleRename(file);

	const after = await identity.resolveNoteId(file);
	equal('the id is unchanged', after, before);
	equal('the history is intact', (await snapshots.listSnapshots(after!)).length, 1);

	const manifest = await snapshots.getManifest(after!);
	equal('the cached path was updated', manifest?.latestPath, 'Folder/New.md');
});

await scenario('Title: each snapshot records the note title it was captured under', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Old Title.md', 'v1\n');
	const v1 = await snapshots.saveSnapshot(file, 'first');
	const noteId = (await identity.resolveNoteId(file))!;

	vault.renameNote(file, 'Folder/New Title.md');
	await identity.handleRename(file);
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nv2\n`);
	const v2 = await snapshots.saveSnapshot(file, 'second');

	const rows = await snapshots.listSnapshots(noteId);
	const byId = (id: string) => rows.find((row) => row.snapshotId === id);
	equal('V1 remembers the original path', byId(v1.row.snapshotId)?.path, 'Old Title.md');
	equal('V2 records the path at its capture', byId(v2.row.snapshotId)?.path, 'Folder/New Title.md');
});

await scenario('Restore: content only — the note is never renamed or moved', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Draft.md', 'v1\n');
	const v1 = await snapshots.saveSnapshot(file, 'first');
	const noteId = (await identity.resolveNoteId(file))!;

	// The user renames the note themselves and keeps working.
	vault.renameNote(file, 'Final.md');
	await identity.handleRename(file);
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nv2\n`);
	await snapshots.saveSnapshot(file, 'second');

	await restore(snapshots, file, v1.row.snapshotId);
	equal('the note keeps the name the user gave it', file.path, 'Final.md');
	check('nothing is recreated under the old name', !vault.disk.has('Draft.md'));
	equal('content is the restored snapshot', body(vault, file), 'v1\n');
	equal('identity is unchanged', await identity.resolveNoteId(file), noteId);

	// R1: the restore created no snapshot.
	equal('no snapshot was created by the restore', (await snapshots.listSnapshots(noteId)).length, 2);
});

await scenario('Working state: the current indicator is content-only', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Alpha.md', 'shared body\n');
	const v1 = await snapshots.saveSnapshot(file, 'first');

	const clean = await snapshots.getProxyWorkingState(file);
	equal('a freshly snapshotted note is clean', clean.kind === 'clean' && clean.snapshotId, v1.row.snapshotId);

	// Rename only: the content still matches V1, so the note stays clean.
	vault.renameNote(file, 'Beta.md');
	await identity.handleRename(file);

	const afterRename = await snapshots.getProxyWorkingState(file);
	equal('renaming does not make the note unsaved', afterRename.kind === 'clean' && afterRename.snapshotId, v1.row.snapshotId);

	// Editing the body does.
	const noteId = await identity.resolveNoteId(file);
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nshared body — changed\n`);
	equal('an edit reads as unsaved', (await snapshots.getProxyWorkingState(file)).kind, 'unsaved');
});

await scenario('Working state: with identical twins, the badge follows the one restored', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Twins.md', 'body\n');
	const v1 = await snapshots.saveSnapshot(file, 'first');
	const noteId = (await identity.resolveNoteId(file))!;

	// A second, byte-identical snapshot — every explicit save creates one regardless.
	const v2 = await snapshots.saveSnapshot(file, 'copy');
	equal('two snapshots, same content', (await snapshots.listSnapshots(noteId)).length, 2);

	const atV2 = await snapshots.getProxyWorkingState(file);
	equal('right after saving it, the newer twin is current', atV2.kind === 'clean' && atV2.snapshotId, v2.row.snapshotId);

	await restore(snapshots, file, v1.row.snapshotId);
	const atV1 = await snapshots.getProxyWorkingState(file);
	equal('restoring the older twin moves the badge to it', atV1.kind === 'clean' && atV1.snapshotId, v1.row.snapshotId);

	await restore(snapshots, file, v2.row.snapshotId);
	const backAtV2 = await snapshots.getProxyWorkingState(file);
	equal('and back again', backAtV2.kind === 'clean' && backAtV2.snapshotId, v2.row.snapshotId);
});

await scenario('Attachments: a subfolder image follows the note to its new folder on restore', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('Projects/assets/pic.png', bytes('pixels-v1'));
	const file = vault.createNote('Projects/Note.md', '![](assets/pic.png)\n');
	const v1 = await snapshots.saveSnapshot(file, 'with image');
	const noteId = (await identity.resolveNoteId(file))!;
	equal('the recorded attachment path is under the old folder', v1.row.attachments?.[0]?.path, 'Projects/assets/pic.png');

	// The note is moved to another folder; the now-unreferenced image is swept up by
	// some unrelated cleanup tool.
	vault.renameNote(file, 'Archive/Note.md');
	await identity.handleRename(file);
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nno image\n`);
	await snapshots.saveSnapshot(file, 'image gone');
	vault.deleteAttachment('Projects/assets/pic.png');

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the plan reports it will be recreated', plan.attachmentsToRecreate.join(','), 'pic.png');

	const restored = await restore(snapshots, file, v1.row.snapshotId);
	equal('exactly one attachment was recreated', restored.attachmentsRecreated, 1);
	check('it landed beside the note in its current folder', await vault.app.vault.adapter.exists('Archive/assets/pic.png'));
	check('nothing was recreated under the old folder', !(await vault.app.vault.adapter.exists('Projects/assets/pic.png')));
});

await scenario('Attachments: a stale copy left at the old folder does not block recreation', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('Projects/assets/pic.png', bytes('pixels-v1'));
	const file = vault.createNote('Projects/Note.md', '![](assets/pic.png)\n');
	const v1 = await snapshots.saveSnapshot(file, 'with image');

	// The note moves to a new folder, but nothing moved the attachment along with it —
	// no cleanup tool touched it, it is just left behind at its old path.
	vault.renameNote(file, 'Archive/Note.md');
	await identity.handleRename(file);

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the plan reports it will be recreated', plan.attachmentsToRecreate.join(','), 'pic.png');

	const restored = await restore(snapshots, file, v1.row.snapshotId);
	equal('it is recreated rather than left unresolved', restored.attachmentsRecreated, 1);
	check(
		'it lands beside the note in its new folder, where the relative embed now looks',
		await vault.app.vault.adapter.exists('Archive/assets/pic.png'),
	);
	check('the stale copy at the old folder is left alone, not deleted', await vault.app.vault.adapter.exists('Projects/assets/pic.png'));
});

await scenario('§4 rename without an event: history is refound lazily', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Ext.md', 'text\n');
	await snapshots.saveSnapshot(file, 'v1');
	const before = (await identity.resolveNoteId(file))!;

	// No handleRename call at all: this is `mv` behind Obsidian's back.
	vault.renameNote(file, 'Moved.md');

	const after = await identity.resolveNoteId(file);
	equal('the id still resolves from frontmatter', after, before);
	equal('the history is intact', (await snapshots.listSnapshots(after!)).length, 1);
});

await scenario('§4 copy: a duplicate forks instead of hijacking the original', async () => {
	const { vault, snapshots, identity } = harness();
	const original = vault.createNote('Original.md', 'shared\n');
	await snapshots.saveSnapshot(original, 'original v1');
	const originalId = (await identity.resolveNoteId(original))!;

	const copy = vault.copyNote(original, 'Copy.md');
	const copyId = await identity.resolveNoteId(copy);

	check('the copy got a fresh id', copyId !== null && copyId !== originalId);
	equal('the copy starts with no history', (await snapshots.listSnapshots(copyId!)).length, 0);
	equal('the original kept its history', (await snapshots.listSnapshots(originalId)).length, 1);
	equal('the original still resolves to its own id', await identity.resolveNoteId(original), originalId);
});

await scenario('Delete: removing a snapshot leaves the rest alone', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Del.md', 'A\n');
	const v1 = await snapshots.saveSnapshot(file, 'A');
	const noteId = (await identity.resolveNoteId(file))!;
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nB\n`);
	const v2 = await snapshots.saveSnapshot(file, 'B');

	await snapshots.removeSnapshot(noteId, v1.row.snapshotId);
	const rows = await snapshots.listSnapshots(noteId);
	equal('one snapshot remains', rows.length, 1);
	equal('it is the one we kept', rows[0]?.snapshotId, v2.row.snapshotId);
	check('the deleted content file is gone', !vault.disk.has(`.note-snapshots/${noteId}/${v1.row.snapshotId}.md`));

	await snapshots.removeSnapshot(noteId, v2.row.snapshotId);
	const manifest = await snapshots.getManifest(noteId);
	equal('activeSnapshotId is cleared when the current snapshot goes', manifest?.activeSnapshotId, null);
});

await scenario('Message: a snapshot carries a free-text note, editable after the fact', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Notes.md', 'a\n');

	const v1 = await snapshots.saveSnapshot(file, 'first');
	const noteId = (await identity.resolveNoteId(file))!;
	equal('no note yet', v1.row.message, undefined);
	const rowOf = async (id: string) => (await snapshots.listSnapshots(noteId)).find((r) => r.snapshotId === id);

	// annotate() edits name and note together; a blank string clears that field.
	await snapshots.annotateSnapshot(noteId, v1.row.snapshotId, 'renamed', 'Final wording locked in.');
	let row = await rowOf(v1.row.snapshotId);
	equal('annotate sets the name', row?.name, 'renamed');
	equal('annotate sets the note', row?.message, 'Final wording locked in.');

	await snapshots.annotateSnapshot(noteId, v1.row.snapshotId, '', '   ');
	row = await rowOf(v1.row.snapshotId);
	equal('a blank name clears it', row?.name, undefined);
	equal('a blank note clears it', row?.message, undefined);
	const raw = JSON.parse(vault.disk.get(`.note-snapshots/${noteId}/manifest.json`) ?? '{}');
	check('both keys are gone from disk', !('message' in (raw.snapshots?.[v1.row.snapshotId] ?? {})) && !('name' in (raw.snapshots?.[v1.row.snapshotId] ?? {})));

	// annotate can also set just one of the two.
	await snapshots.annotateSnapshot(noteId, v1.row.snapshotId, 'label only', '');
	row = await rowOf(v1.row.snapshotId);
	equal('name set alone', row?.name, 'label only');
	equal('note still empty', row?.message, undefined);

	// On a fresh snapshot, name and note are independent, and a blank note is dropped.
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nb\n`);
	const v2 = await snapshots.saveSnapshot(file, 'second', 'Draft ending.');
	equal('name set', v2.row.name, 'second');
	equal('note set', v2.row.message, 'Draft ending.');
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nc\n`);
	const v3 = await snapshots.saveSnapshot(file, 'third', '   ');
	equal('whitespace-only note is dropped', v3.row.message, undefined);
});

await scenario('Numbering: snapshot numbers are positional and renumber on delete', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Numbered.md', 'a\n');
	const v1 = await snapshots.saveSnapshot(file, 'one');
	const noteId = (await identity.resolveNoteId(file))!;
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nb\n`);
	const v2 = await snapshots.saveSnapshot(file, 'two');
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nc\n`);
	const v3 = await snapshots.saveSnapshot(file, 'three');

	let rows = await snapshots.listSnapshots(noteId);
	equal('newest is listed first', rows[0]?.snapshotId, v3.row.snapshotId);
	equal('numbered high to low', rows.map((r) => r.n).join(','), '3,2,1');
	equal('the newest snapshot is V3', rows.find((r) => r.snapshotId === v3.row.snapshotId)?.n, 3);
	equal('the snapshot outcome carried the same number', v3.row.n, 3);

	// Drop the middle one; the survivors close the gap.
	await snapshots.removeSnapshot(noteId, v2.row.snapshotId);
	rows = await snapshots.listSnapshots(noteId);
	equal('two snapshots remain', rows.length, 2);
	equal('the former V3 is now V2', rows.find((r) => r.snapshotId === v3.row.snapshotId)?.n, 2);
	equal('the former V1 is still V1', rows.find((r) => r.snapshotId === v1.row.snapshotId)?.n, 1);
	equal('numbers stay contiguous', rows.map((r) => r.n).join(','), '2,1');

	// The stored manifest never carries the number.
	const raw = JSON.parse(vault.disk.get(`.note-snapshots/${noteId}/manifest.json`) ?? '{}');
	check(
		'no snapshot entry stores an "n" field',
		Object.values(raw.snapshots ?? {}).every((meta) => !(meta as Record<string, unknown>).n),
	);
});

await scenario('Ordering: snapshots are ordered by timestamp, not insertion quirks', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Ordered.md', 'a\n');
	await snapshots.saveSnapshot(file, 'first');
	const noteId = (await identity.resolveNoteId(file))!;
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nb\n`);
	await snapshots.saveSnapshot(file, 'second');
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nc\n`);
	await snapshots.saveSnapshot(file, 'third');

	const rows = await snapshots.listSnapshots(noteId);
	equal('descending timestamps', [...rows].every((r, i) => i === 0 || rows[i - 1]!.ts >= r.ts), true);
	equal('newest name first', rows.map((r) => r.name).join(','), 'third,second,first');
});

await scenario('Ordering: a backwards clock cannot make a new snapshot sort as older', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Clock.md', 'a\n');
	const v1 = await snapshots.saveSnapshot(file, 'first');
	const noteId = (await identity.resolveNoteId(file))!;

	// Rewrite V1's stored time to an hour in the future, as if the machine clock was
	// ahead then (or has been set back since).
	const path = `.note-snapshots/${noteId}/manifest.json`;
	const manifest = JSON.parse(vault.disk.get(path)!);
	const future = new Date(Date.now() + 3_600_000).toISOString();
	manifest.snapshots[v1.row.snapshotId].ts = future;
	vault.disk.set(path, JSON.stringify(manifest, null, 2));

	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nb\n`);
	const v2 = await snapshots.saveSnapshot(file, 'second');

	check('V2 timestamp is nudged past V1 despite the clock', v2.row.ts > future);
	const rows = await snapshots.listSnapshots(noteId);
	equal('V2 still outranks V1', rows.find((r) => r.snapshotId === v2.row.snapshotId)?.n, 2);
	equal('and lists first', rows[0]?.snapshotId, v2.row.snapshotId);
});

await scenario('Lock: a locked snapshot resists deletion, single and bulk', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Locked.md', 'A\n');
	const v1 = await snapshots.saveSnapshot(file, 'A');
	const noteId = (await identity.resolveNoteId(file))!;
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nB\n`);
	const v2 = await snapshots.saveSnapshot(file, 'B');

	await snapshots.setSnapshotLocked(noteId, v1.row.snapshotId, true);
	let threw = false;
	try {
		await snapshots.removeSnapshot(noteId, v1.row.snapshotId);
	} catch {
		threw = true;
	}
	check('removing a locked snapshot throws', threw);
	equal('both snapshots still exist', (await snapshots.listSnapshots(noteId)).length, 2);

	const { removed, kept } = await snapshots.removeAllSnapshots(noteId);
	equal('only the unlocked snapshot was removed', removed, 1);
	equal('the locked snapshot was kept', kept, 1);
	const remaining = await snapshots.listSnapshots(noteId);
	equal('one snapshot remains', remaining.length, 1);
	equal('it is the locked one', remaining[0]?.snapshotId, v1.row.snapshotId);
	check('the unlocked snapshot is gone', !remaining.some((row) => row.snapshotId === v2.row.snapshotId));

	await snapshots.setSnapshotLocked(noteId, v1.row.snapshotId, false);
	await snapshots.removeSnapshot(noteId, v1.row.snapshotId);
	equal('an unlocked snapshot can be deleted', (await snapshots.listSnapshots(noteId)).length, 0);
});

await scenario('Attachments: a snapshot backs up an embedded image', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('image.png', bytes('pixels-v1'));
	const file = vault.createNote('WithImage.md', '![[image.png]]\n');

	const v1 = await snapshots.saveSnapshot(file, 'has image');
	equal('the snapshot recorded one attachment', v1.row.attachments?.length, 1);
	equal('the recorded path matches the vault file', v1.row.attachments?.[0]?.path, 'image.png');

	const noteId = (await identity.resolveNoteId(file))!;
	const hash = v1.row.attachments![0]!.hash;
	check(
		'the attachment blob was written to the store',
		vault.storeFiles().includes(`.note-snapshots/${noteId}/attachments/${hash}.bin`),
	);
});

await scenario('Attachments: restoring recreates an image deleted by another tool', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('image.png', bytes('pixels-v1'));
	const file = vault.createNote('Restore.md', '![[image.png]]\n');
	const v1 = await snapshots.saveSnapshot(file, 'with image');
	const noteId = (await identity.resolveNoteId(file))!;

	// The note is edited to drop the image, and later some unrelated "delete orphan
	// attachments" plugin removes the now-unreferenced file from the vault.
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nno image here\n`);
	await snapshots.saveSnapshot(file, 'image removed');
	vault.deleteAttachment('image.png');
	check('the attachment is really gone from the vault', !(await vault.app.vault.adapter.exists('image.png')));

	const restored = await restore(snapshots, file, v1.row.snapshotId);
	equal('exactly one attachment was recreated', restored.attachmentsRecreated, 1);
	check('the attachment exists again', await vault.app.vault.adapter.exists('image.png'));
	equal(
		'the recreated bytes match the original backup',
		Buffer.from(await vault.app.vault.adapter.readBinary('image.png')).toString(),
		'pixels-v1',
	);
});

await scenario('Attachments: restore never overwrites an attachment that still exists', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('image.png', bytes('pixels-v1'));
	const file = vault.createNote('Keep.md', '![[image.png]]\n');
	const v1 = await snapshots.saveSnapshot(file, 'with image');
	const noteId = (await identity.resolveNoteId(file))!;
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nno image\n`);
	await snapshots.saveSnapshot(file, 'no image');

	// Someone replaced the attachment's content without deleting it.
	vault.binaryDisk.set('image.png', bytes('a-completely-different-image'));

	const restored = await restore(snapshots, file, v1.row.snapshotId);
	equal('nothing needed recreating', restored.attachmentsRecreated, 0);
	equal('the changed file is reported, not touched', restored.attachmentsSkipped.join(','), 'image.png');
	equal('no divergent file was overwritten', restored.attachmentsOverwrittenAndRecoverable.length, 0);
	equal(
		'the existing (different) file was left alone',
		Buffer.from(await vault.app.vault.adapter.readBinary('image.png')).toString(),
		'a-completely-different-image',
	);
});

await scenario('Attachments: a changed file whose bytes are in a snapshot can be replaced safely', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('diagram.png', bytes('diagram-v1'));
	const file = vault.createNote('Doc.md', '![[diagram.png]]\nnote v1\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	// The user edits the diagram and the note, then snapshots — so v2 holds the new bytes.
	vault.binaryDisk.set('diagram.png', bytes('diagram-v2-longer'));
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\n![[diagram.png]]\nnote v2\n`);
	const v2 = await snapshots.saveSnapshot(file, 'v2');

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the changed diagram is classed safe', plan.attachmentsToOverwriteAndCaptured.length, 1);
	equal('nothing is at risk', plan.attachmentsToOverwriteAndUncaptured.length, 0);
	equal('the changed diagram is named', plan.attachmentsToOverwriteAndCaptured[0], 'diagram.png');

	const outcome = await restore(snapshots, file, v1.row.snapshotId, { attachments: 'replace' });
	equal('no backup was needed', outcome.backup, null);
	equal('the history did not grow', (await snapshots.listSnapshots(noteId)).length, 2);
	equal('one attachment was replaced', outcome.attachmentsOverwrittenAndRecoverable.length, 1);
	equal('the replaced diagram is named', outcome.attachmentsOverwrittenAndRecoverable[0], 'diagram.png');
	equal(
		'the diagram is back to its V1 bytes',
		Buffer.from(await vault.app.vault.adapter.readBinary('diagram.png')).toString(),
		'diagram-v1',
	);
	void v2;
});

await scenario('Attachments: a changed file in no snapshot forces one backup before it is overwritten', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('chart.png', bytes('chart-a'));
	const file = vault.createNote('Report.md', '![[chart.png]]\nbody\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	// The chart is edited in place and never snapshotted — its current bytes exist nowhere else.
	vault.binaryDisk.set('chart.png', bytes('chart-b-edited'));

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the edit is at risk', plan.attachmentsToOverwriteAndUncaptured.length, 1);
	equal('and not classed safe', plan.attachmentsToOverwriteAndCaptured.length, 0);
	equal('the at-risk file is named', plan.attachmentsToOverwriteAndUncaptured[0], 'chart.png');

	const outcome = await backupAndRestore(snapshots, file, v1.row.snapshotId);
	check('a backup snapshot was taken', outcome.backup !== null);
	equal('exactly one new snapshot', (await snapshots.listSnapshots(noteId)).length, 2);
	equal('the chart was overwritten', outcome.attachmentsOverwrittenAndRecoverable.length, 1);
	equal('the replaced chart is named', outcome.attachmentsOverwrittenAndRecoverable[0], 'chart.png');
	equal(
		'the chart is back to its V1 bytes',
		Buffer.from(await vault.app.vault.adapter.readBinary('chart.png')).toString(),
		'chart-a',
	);

	const backup = (await snapshots.listSnapshots(noteId)).find((row) => row.snapshotId === outcome.backup!.snapshotId);
	equal('the backup captured the edited chart', backup?.attachments?.length, 1);

	// Self-resolving: the once-at-risk edit now lives in a snapshot, so a later restore
	// treats it as safe rather than nagging again.
	await restore(snapshots, file, outcome.backup!.snapshotId, { attachments: 'replace' });
	const laterPlan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the edit is now safe', laterPlan.attachmentsToOverwriteAndCaptured.length, 1);
	equal('nothing is at risk any more', laterPlan.attachmentsToOverwriteAndUncaptured.length, 0);
});

await scenario('Attachments: "Snapshot & restore" still brings back a version the note no longer embeds', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('old.png', bytes('old-v1'));
	const file = vault.createNote('Drifted.md', '![[old.png]]\nv1\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	// V2 drops the embed entirely, then old.png is edited in place with no note ever
	// referencing it again — its current bytes are captured by nothing.
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nv2, no image\n`);
	await snapshots.saveSnapshot(file, 'v2');
	vault.binaryDisk.set('old.png', bytes('old-orphaned-edit'));

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the target still references it, so it is at risk', plan.attachmentsToOverwriteAndUncaptured.length, 1);

	// The forced backup captures the note's current (v2) content, which does not embed
	// old.png — so the backup cannot rescue it — but the restore still brings V1 back,
	// rather than getting stuck skipping it forever.
	const outcome = await backupAndRestore(snapshots, file, v1.row.snapshotId);
	equal('nothing was left in place', outcome.attachmentsSkipped.length, 0);
	equal('it is reported as unrecoverable, not silently kept', outcome.attachmentsOverwrittenAndUnrecoverable.join(','), 'old.png');
	equal(
		'old.png is back to its V1 bytes',
		Buffer.from(await vault.app.vault.adapter.readBinary('old.png')).toString(),
		'old-v1',
	);
});

await scenario('Attachments: an unsaved body and a changed attachment share one backup', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('fig.png', bytes('fig-1'));
	const file = vault.createNote('Paper.md', '![[fig.png]]\ndraft one\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	// Both the note body and the figure are edited, and neither is snapshotted.
	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\n![[fig.png]]\ndraft two, unsaved\n`);
	vault.binaryDisk.set('fig.png', bytes('fig-2-unsaved'));
	equal('the body reads as unsaved', (await snapshots.getWorkingState(file)).kind, 'unsaved');

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the figure is at risk', plan.attachmentsToOverwriteAndUncaptured.length, 1);

	const outcome = await backupAndRestore(snapshots, file, v1.row.snapshotId);
	equal('exactly one backup covers both', (await snapshots.listSnapshots(noteId)).length, 2);
	equal('the backup holds the unsaved body', outcome.backup?.name, UNSAVED_LABEL);
	equal('and the figure is named', outcome.attachmentsOverwrittenAndRecoverable[0], 'fig.png');
	equal(
		'the figure is restored to V1',
		Buffer.from(await vault.app.vault.adapter.readBinary('fig.png')).toString(),
		'fig-1',
	);
	equal('the body is restored to V1', body(vault, file), '![[fig.png]]\ndraft one\n');
});

await scenario('Attachments: "when-unsaved" restore leaves changed files alone unless asked', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('pic.png', bytes('pic-1'));
	const file = vault.createNote('Note.md', '![[pic.png]]\ntext\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;
	vault.binaryDisk.set('pic.png', bytes('pic-2-changed'));

	// The default restore (mode 'skip') never overwrites a present file.
	const outcome = await restore(snapshots, file, v1.row.snapshotId);
	equal('the changed pic was left in place', outcome.attachmentsOverwrittenAndRecoverable.length, 0);
	equal('and reported as skipped', outcome.attachmentsSkipped.join(','), 'pic.png');
	equal(
		'its bytes are untouched',
		Buffer.from(await vault.app.vault.adapter.readBinary('pic.png')).toString(),
		'pic-2-changed',
	);
	void noteId;
});

await scenario('Attachments: "replace" overwrites a changed file even when its current bytes exist nowhere else', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('pic.png', bytes('pic-1'));
	const file = vault.createNote('Note.md', '![[pic.png]]\ntext\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;
	vault.binaryDisk.set('pic.png', bytes('pic-2-uncaptured'));

	// Text still matches v1 exactly, but the attachment has since changed in place —
	// genuine unsaved work (see getWorkingState). Passing
	// dropUnsavedWork skips the automatic backup that would otherwise capture and
	// recover it, so this restore's "replace" truly discards the only copy.
	const outcome = await restore(snapshots, file, v1.row.snapshotId, { attachments: 'replace', dropUnsavedWork: true });
	equal('nothing was left in place', outcome.attachmentsSkipped.length, 0);
	equal('it was not reported as recoverable', outcome.attachmentsOverwrittenAndRecoverable.length, 0);
	equal('it is reported as discarded', outcome.attachmentsOverwrittenAndUnrecoverable.join(','), 'pic.png');
	equal(
		'the pic is back to its V1 bytes, the uncaptured edit is gone',
		Buffer.from(await vault.app.vault.adapter.readBinary('pic.png')).toString(),
		'pic-1',
	);
	void noteId;
});

await scenario('Attachments: an in-place attachment change is detected as unsaved work even when the text still matches', async () => {
	const { vault, snapshots } = harness();
	vault.createAttachment('pic.png', bytes('pic-1'));
	const file = vault.createNote('Combo.md', '![[pic.png]]\ntext\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	vault.binaryDisk.set('pic.png', bytes('pic-2'));

	equal('text alone still reads clean', (await snapshots.getProxyWorkingState(file)).kind, 'clean');
	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the combined plan sees unsaved work', plan.workingState?.kind, 'unsaved');

	const outcome = await snapshots.restoreSnapshot(file, plan, { attachments: 'replace' });
	check('a backup captured the changed attachment first', outcome.backup !== null);
	equal('the overwritten attachment is recoverable from that backup', outcome.attachmentsOverwrittenAndRecoverable.length, 1);
});

await scenario('Attachments: the combo check finds a matching twin even when it is not the one getProxyWorkingState prefers', async () => {
	const { vault, snapshots } = harness();
	vault.createAttachment('pic.png', bytes('pic-1'));
	const file = vault.createNote('Twins.md', '![[pic.png]]\ntext\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');

	// An attachment-only edit still records a new snapshot on an explicit save: v2's
	// text is byte-identical to v1's, but its attachment differs. v2 becomes active.
	vault.binaryDisk.set('pic.png', bytes('pic-2'));
	const v2 = await snapshots.saveSnapshot(file, 'v2');

	// Revert the attachment back to what v1 — not v2 — recorded. Text still matches both.
	vault.binaryDisk.set('pic.png', bytes('pic-1'));

	const working = await snapshots.getProxyWorkingState(file);
	equal(
		'text alone prefers the active twin (v2), which no longer matches the attachment',
		working.kind === 'clean' ? working.snapshotId : null,
		v2.row.snapshotId,
	);

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the combo check still finds a genuine match', plan.workingState?.kind, 'clean');
	equal(
		'and names the twin that actually matches (v1), not the one getProxyWorkingState preferred',
		plan.workingState?.kind === 'clean' ? plan.workingState.snapshotId : null,
		v1.row.snapshotId,
	);

	const outcome = await snapshots.restoreSnapshot(file, plan);
	check('no unnecessary backup was created', outcome.backup === null);
});

await scenario('Attachments: identical images across snapshots are stored once', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('shared.png', bytes('same-bytes'));
	const file = vault.createNote('Dedup.md', '![[shared.png]]\nv1\n');
	await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\n![[shared.png]]\nv2\n`);
	await snapshots.saveSnapshot(file, 'v2');

	const attachmentFiles = vault.storeFiles().filter((path) => path.includes('/attachments/'));
	equal('only one blob is stored for the shared image', attachmentFiles.length, 1);
});

await scenario('Attachments: garbage collected once no surviving snapshot needs them', async () => {
	const { vault, snapshots, identity } = harness();
	vault.createAttachment('only.png', bytes('lonely-bytes'));
	const file = vault.createNote('Gc.md', '![[only.png]]\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	check(
		'the blob exists right after the snapshot',
		vault.storeFiles().some((path) => path.includes('/attachments/')),
	);

	await snapshots.removeSnapshot(noteId, v1.row.snapshotId);
	check(
		'the blob is gone once its only snapshot is deleted',
		!vault.storeFiles().some((path) => path.includes('/attachments/')),
	);
});

/** A buffer of `size` bytes, every byte set to `fill` — for same-length, different-content attachments. */
function bigBytes(size: number, fill: number): ArrayBuffer {
	return Buffer.alloc(size, fill).buffer.slice(0, size) as ArrayBuffer;
}

await scenario('Large attachments: a same-size change above the threshold is assumed unchanged', async () => {
	const oneMB = 1024 * 1024;
	const { vault, snapshots } = harness({ largeAttachmentThresholdMB: 1 });
	vault.createAttachment('big.bin', bigBytes(oneMB + 1, 0xaa));
	const file = vault.createNote('Big.md', '![[big.bin]]\nv1\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');

	// Same length, different bytes — above the 1 MB threshold, so this should not be hashed.
	vault.binaryDisk.set('big.bin', bigBytes(oneMB + 1, 0xbb));

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('the change is assumed unchanged, not flagged', plan.attachmentsAssumedUnchanged.join(','), 'big.bin');
	equal('it is not classed safe-to-overwrite', plan.attachmentsToOverwriteAndCaptured.length, 0);
	equal('it is not classed at-risk either', plan.attachmentsToOverwriteAndUncaptured.length, 0);
});

await scenario('Large attachments: a threshold of 0 always hashes, however large the file', async () => {
	const oneMB = 1024 * 1024;
	const { vault, snapshots } = harness({ largeAttachmentThresholdMB: 0 });
	vault.createAttachment('big.bin', bigBytes(oneMB + 1, 0xaa));
	const file = vault.createNote('Big.md', '![[big.bin]]\nv1\n');
	const v1 = await snapshots.saveSnapshot(file, 'v1');

	// Same length, different bytes — with hashing never skipped, this is still caught.
	vault.binaryDisk.set('big.bin', bigBytes(oneMB + 1, 0xbb));

	const plan = await snapshots.computeRestorePlan(file, v1.row.snapshotId);
	equal('nothing is assumed unchanged', plan.attachmentsAssumedUnchanged.length, 0);
	equal('the change is caught and classed at-risk', plan.attachmentsToOverwriteAndUncaptured.join(','), 'big.bin');
});

await scenario('Orphans: a deleted note keeps its history until purged', async () => {
	const { vault, snapshots, identity } = harness({ purgeOrphansAfterDays: 30 });
	const file = vault.createNote('Gone.md', 'text\n');
	await snapshots.saveSnapshot(file, 'v1');
	const noteId = (await identity.resolveNoteId(file))!;

	vault.deleteNote(file);
	await identity.handleDelete('Gone.md');

	equal('history is retained immediately after deletion', (await snapshots.listSnapshots(noteId)).length, 1);
	equal('nothing is purgeable yet', (await identity.listPurgeableOrphans(30)).length, 0);
	check('it becomes purgeable once the window passes', (await identity.listPurgeableOrphans(0)).includes(noteId));

	await identity.purgeOrphans(0);
	equal('the store is empty afterwards', (await snapshots.listSnapshots(noteId)).length, 0);
	check('no snapshot files remain', !vault.storeFiles().some((path) => path.includes(noteId)));
});

await scenario('Lock: concurrent snapshots of one note do not interleave', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Race.md', 'A\n');
	// Establish identity up front — minting a note's very first id has its own,
	// separate race outside the scope of this test, which is about the per-note
	// queue serializing concurrent manifest writes once identity is already settled.
	await identity.resolveOrCreateNoteId(file);

	// Same content, fired together: the queue serializes them so all three land safely,
	// each its own snapshot — nothing corrupts the manifest, and none get lost.
	await Promise.all([snapshots.saveSnapshot(file), snapshots.saveSnapshot(file), snapshots.saveSnapshot(file)]);

	const noteId = (await identity.resolveNoteId(file))!;
	equal('all three snapshots exist', (await snapshots.listSnapshots(noteId)).length, 3);
});

await scenario('Settings: the pre-1.0 boolean confirm-restore setting migrates', async () => {
	equal('true becomes "always"', normaliseSettings({ confirmRestore: true }).confirmRestore, 'always');
	equal('false becomes "never"', normaliseSettings({ confirmRestore: false }).confirmRestore, 'never');
	equal('nonsense falls back to the default', normaliseSettings({ confirmRestore: 'nope' }).confirmRestore, DEFAULT_SETTINGS.confirmRestore);
	equal('a valid policy survives a round trip', normaliseSettings(normaliseSettings({ confirmRestore: true })).confirmRestore, 'always');
	equal('an empty template is kept, not defaulted', normaliseSettings({ snapshotNameTemplate: '' }).snapshotNameTemplate, '');
});

await scenario('Restore prompts: "when-unsaved" asks only when a restore would overwrite unsaved work', async () => {
	const { vault, snapshots, identity } = harness();
	const file = vault.createNote('Prompt.md', 'A\n');
	const v1 = await snapshots.saveSnapshot(file, 'A');
	const noteId = (await identity.resolveNoteId(file))!;

	const clean = await snapshots.getWorkingState(file);
	equal('a saved note is clean', clean.kind, 'clean');
	check('clean needs no prompt', !shouldConfirmRestore('when-unsaved', clean));
	check('clean still prompts under "always"', shouldConfirmRestore('always', clean));
	check('clean never prompts under "never"', !shouldConfirmRestore('never', clean));

	await vault.app.vault.modify(file, `---\nns-id: ${noteId}\n---\nB\n`);
	const unsaved = await snapshots.getWorkingState(file);
	equal('an edited note is unsaved', unsaved.kind, 'unsaved');
	check('unsaved prompts under "when-unsaved"', shouldConfirmRestore('when-unsaved', unsaved));
	check('unsaved never prompts under "never"', !shouldConfirmRestore('never', unsaved));

	// An unreadable state is not provably safe, so it is treated like unsaved work.
	check('an unknown state prompts', shouldConfirmRestore('when-unsaved', null));

	// The wording has to match the stake, since that is the whole point of asking.
	check(
		'the clean message names which snapshot already has the content',
		restoreConfirmationMessage('Prompt', v1.row, { kind: 'clean', snapshotId: 'other', n: 7 }).includes(
			'identical to V7',
		),
	);
	check(
		'restoring the snapshot you are on says so',
		restoreConfirmationMessage('Prompt', v1.row, { kind: 'clean', snapshotId: v1.row.snapshotId, n: v1.row.n }).includes(
			'is identical to',
		),
	);
	check(
		'the unsaved message promises a backup',
		restoreConfirmationMessage('Prompt', v1.row, unsaved).includes('can be captured first'),
	);
	check(
		'the message never talks about renaming or moving the note',
		!/renamed|moved/.test(restoreConfirmationMessage('Prompt', v1.row, unsaved)),
	);
});

await scenario('Snapshot names: presets and templates render', async () => {
	const now = new Date(2026, 8, 6, 14, 32, 5);
	const context = { note: 'Meeting notes', now };

	equal('none suggests nothing', suggestedSnapshotName(DEFAULT_SETTINGS, context), '');
	equal(
		'the date preset',
		suggestedSnapshotName({ ...DEFAULT_SETTINGS, snapshotNameSuggestion: 'date' }, context),
		'2026-09-06',
	);
	equal(
		'the date-and-time preset',
		suggestedSnapshotName({ ...DEFAULT_SETTINGS, snapshotNameSuggestion: 'datetime' }, context),
		'2026-09-06 14:32',
	);
	equal(
		'the custom preset uses the template',
		suggestedSnapshotName(
			{ ...DEFAULT_SETTINGS, snapshotNameSuggestion: 'custom', snapshotNameTemplate: '{{note}} — {{time}}' },
			context,
		),
		'Meeting notes — 14:32',
	);
	equal('epoch milliseconds', renderNameTemplate('{{timestamp}}', context), String(now.getTime()));
	equal('an ISO instant', renderNameTemplate('{{iso}}', context), now.toISOString());
	equal('whitespace inside the braces is tolerated', renderNameTemplate('{{ date }}', context), '2026-09-06');
	equal('a token is case-insensitive', renderNameTemplate('{{Date}}', context), '2026-09-06');
	equal('an unknown token stays visible', renderNameTemplate('{{nope}}', context), '{{nope}}');
	equal('surrounding whitespace is trimmed away', renderNameTemplate('  {{date}}  ', context), '2026-09-06');
	equal('a template of only whitespace suggests nothing', renderNameTemplate('   ', context), '');
});

await scenario('Restore notice: one line covers the body and every attachment touched', async () => {
	const make = (over: Partial<RestoreOutcome>): RestoreOutcome => ({
		restored: { snapshotId: 'r', n: 1, ts: '', hash: '', size: 0 },
		backup: null,
		attachmentsRecreated: 0,
		attachmentsOverwrittenAndRecoverable: [],
		attachmentsOverwrittenAndUnrecoverable: [],
		attachmentsSkipped: [],
		...over,
	});

	equal('a plain checkout', describeRestoreOutcome(make({}), 'skip'), 'Restored V1.');
	equal(
		'one backup, one replaced file, merged into a single sentence',
		describeRestoreOutcome(
			make({
				backup: { snapshotId: 'b', n: 3, ts: '', hash: '', size: 0 },
				attachmentsOverwrittenAndRecoverable: ['d.png'],
			}),
			'replace',
		),
		'Saved the previous state as V3, then restored V1. Replaced "d.png".',
	);
	equal(
		'several replaced files collapse into one clause',
		describeRestoreOutcome(
			make({
				backup: { snapshotId: 'b', n: 3, ts: '', hash: '', size: 0 },
				attachmentsOverwrittenAndRecoverable: ['a.png', 'b.png', 'c.png', 'd.png'],
			}),
			'replace',
		),
		'Saved the previous state as V3, then restored V1. Replaced 4 attachments.',
	);
	equal(
		'a text-only restore names what stayed behind',
		describeRestoreOutcome(make({ attachmentsSkipped: ['x.png', 'y.png'] }), 'skip'),
		`Restored V1's text. "x.png" and "y.png" still show a later version.`,
	);
	equal(
		'a discard names what was lost for good',
		describeRestoreOutcome(make({ attachmentsOverwrittenAndUnrecoverable: ['e.png'] }), 'replace'),
		'Restored V1. Discarded the current copy of "e.png".',
	);
});

await scenario('Diff rows: word-level emphasis and per-side line numbers', async () => {
	const identical = buildDiffRows('a\nb\nc\n', 'a\nb\nc\n');
	check('identical texts report nothing to show', identical.identical);
	equal('and every row is context', identical.rows.every((row) => row.kind === 'ctx'), true);

	const modified = buildDiffRows('the quick brown fox\n', 'the quick red fox\n');
	equal('a one-word edit is +1 / −1 lines', `${modified.addedLines}/${modified.removedLines}`, '1/1');
	const del = modified.rows.find((row) => row.kind === 'del')!;
	const add = modified.rows.find((row) => row.kind === 'add')!;
	equal('the removed word is the only emphasis on the old line', del.segments.filter((s) => s.emphasis).map((s) => s.text).join('|'), 'brown');
	equal('the added word is the only emphasis on the new line', add.segments.filter((s) => s.emphasis).map((s) => s.text).join('|'), 'red');
	equal('shared words stay plain', del.segments.filter((s) => !s.emphasis).map((s) => s.text).join(''), 'the quick  fox');

	const inserted = buildDiffRows('line one\nline two\n', 'line one\nadded\nline two\n');
	equal('a pure insertion counts one added line', inserted.addedLines, 1);
	const addedRow = inserted.rows.find((row) => row.kind === 'add')!;
	equal('an unpaired added line carries no emphasis', addedRow.segments.some((s) => s.emphasis), false);
	equal('its old-side number is blank', addedRow.oldNumber, null);
	equal('its new-side number is 2', addedRow.newNumber, 2);
	const lastCtx = inserted.rows.filter((row) => row.kind === 'ctx').at(-1)!;
	equal('the trailing context line is old 2', lastCtx.oldNumber, 2);
	equal('and new 3 after the insertion', lastCtx.newNumber, 3);

	const trailing = buildDiffRows('only line', 'only line\n');
	equal('a bare trailing-newline change adds one row, not a phantom blank', trailing.addedLines, 1);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

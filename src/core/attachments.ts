import { normalizePath, TFile, type App } from 'obsidian';
import type { AttachmentRef, SnapshotMetadata } from '@/types';
import type { Store } from '@/core/store';
import { hashAttachmentBytes } from '@/util/hash';

const WIKI_EMBED = /!\[\[([^\]|#]+)[^\]]*\]\]/g;
const MD_EMBED = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

// --- Capturing attachments ---

/**
 * Backs up every non-note attachment a snapshot's content embeds, so restoring it
 * later does not depend on the attachment still existing anywhere else.
 *
 * Blobs are content-addressed and deduplicated within the note's store: an image
 * embedded unchanged across many snapshots is written once.
 */
export async function captureAttachments(
	app: App,
	store: Store,
	noteId: string,
	notePath: string,
	content: string,
): Promise<AttachmentRef[]> {
	const refs = new Map<string, AttachmentRef>();

	for (const rawLink of extractEmbedLinks(content)) {
		const target = resolveEmbedFile(app, notePath, rawLink);
		if (!target || target.extension === 'md' || refs.has(target.path)) continue;

		const data = await app.vault.readBinary(target);
		const hash = await hashAttachmentBytes(data);
		await store.writeAttachment(noteId, hash, data);
		refs.set(target.path, { path: target.path, hash, size: data.byteLength });
	}

	return [...refs.values()];
}

/** Raw embed targets referenced in note content, as written (not yet resolved). */
function extractEmbedLinks(content: string): string[] {
	const links = new Set<string>();
	for (const match of content.matchAll(WIKI_EMBED)) {
		const raw = match[1]?.trim();
		if (raw) links.add(raw);
	}
	for (const match of content.matchAll(MD_EMBED)) {
		const raw = match[1]?.trim();
		if (!raw) continue;
		try {
			links.add(decodeURIComponent(raw));
		} catch {
			links.add(raw);
		}
	}
	return [...links];
}

/**
 * Resolves a raw embed target to a vault file.
 *
 * Prefers Obsidian's own link resolution, which understands aliases and vault-wide
 * shorthand. The fallback (used by anything without a metadata cache, including the
 * test harness) only understands a path relative to the vault root or to the source
 * note's folder — narrower, but enough for the common case.
 */
function resolveEmbedFile(app: App, notePath: string, rawLink: string): TFile | null {
	const cache = app.metadataCache as unknown as {
		getFirstLinkpathDest?: (linkpath: string, sourcePath: string) => TFile | null;
	};
	if (typeof cache.getFirstLinkpathDest === 'function') {
		const resolved = cache.getFirstLinkpathDest(rawLink, notePath);
		if (resolved) return resolved;
	}

	const direct = app.vault.getAbstractFileByPath(normalizePath(rawLink));
	if (direct instanceof TFile) return direct;

	const folder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
	const relative = app.vault.getAbstractFileByPath(normalizePath(folder ? `${folder}/${rawLink}` : rawLink));
	return relative instanceof TFile ? relative : null;
}

// --- Relocating a moved note's attachments ---

/** The last path segment — a file's display name. */
export function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Where a captured attachment should land now that its note may sit in a different
 * folder than it did at capture. Keeps the note→attachment relationship the embed
 * was written against: an `![[img]]` or a relative `![](sub/img)` that resolved
 * beside the note when captured still resolves beside it after the note moved.
 *
 * Only attachments that lived at or below the note's own folder are relocated — the
 * "same folder as note" and "in subfolder under note" cases. An attachment with an
 * absolute home (the vault root, or a fixed custom folder) keeps its recorded path,
 * because a note move must not drag it around. A non-standard "absolute path in
 * vault" embed (`![](/assets/img.png)`) still resolves in that case — the file is
 * kept exactly where the leading-slash link points; it only breaks when its target
 * sat under the note's own former folder. See the README.
 */
export function relocateAttachmentPath(
	recordedNotePath: string | undefined,
	currentNotePath: string,
	attachmentPath: string,
): string {
	// No note path was recorded — a ref written before this field existed. Nothing to
	// compare the current path against, so there is nothing to do but keep it as-is.
	if (!recordedNotePath) return attachmentPath;
	const recordedDir = parentDir(recordedNotePath);
	const currentDir = parentDir(currentNotePath);
	// Case 1: the note has not moved — the recorded path is still correct.
	if (recordedDir === currentDir) return attachmentPath;

	const prefix = recordedDir ? `${recordedDir}/` : '';
	// Case 2: the note moved, but this attachment lived outside its folder (the vault
	// root, a fixed custom folder, or another absolute location) — leave it where it is.
	if (!attachmentPath.startsWith(prefix)) return attachmentPath;

	// Case 3: the note moved, and this attachment lived at or below its folder —
	// relocate it to sit at or below the note's new folder, keeping the same sub-path.
	const belowNote = attachmentPath.slice(prefix.length);
	return normalizePath(currentDir ? `${currentDir}/${belowNote}` : belowNote);
}

/** The folder part of a vault path, '' for a file at the vault root. */
function parentDir(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

// --- Planning changes against the vault ---

/** The subset of a snapshot's own record that attachment reconciliation needs. */
type RecordedSnapshot = Pick<SnapshotMetadata, 'attachments' | 'path'>;

/** Attachments this size or larger are assumed unchanged rather than re-hashed on every restore. */
const COMPARE_SIZE_CAP = 25 * 1024 * 1024;

type Disposition = 'missing' | 'unchanged' | 'changed' | 'assumedUnchanged';

interface AttachmentWithDisposition {
	ref: AttachmentRef;
	/** Where a missing attachment would be recreated (relocated to the note's current folder). */
	relocatedPath: string;
	/** Where the file actually sits now, or null when nothing is at either candidate path. */
	presentPath: string | null;
	disposition: Disposition;
	/** Hash of the bytes currently at `presentPath`; set only when `disposition` is `changed`. */
	currentHash?: string;
}

/**
 * One attachment's status against the vault now — everything needed to both describe
 * a restore for a confirmation prompt and later execute it, without scanning the vault
 * a second time. Excludes only `unchanged`, which needs no decision and no mention.
 */
export interface AttachmentChange {
	ref: AttachmentRef;
	name: string;
	disposition: Exclude<Disposition, 'unchanged'>;
	/** Where a missing attachment would be recreated. */
	relocatedPath: string;
	/** Where the file actually sits now, so a changed one can be overwritten in place. Absent (null) only when missing. */
	presentPath: string | null;
	currentHash?: string;
}

/** Determines a snapshot's attachments' status against the vault now, without changing anything. */
export async function planAttachmentChanges(
	app: App,
	recordedSnapshot: RecordedSnapshot,
	currentNotePath: string,
): Promise<AttachmentChange[]> {
	const dispositions = await determineAttachmentDispositions(app, recordedSnapshot, currentNotePath);
	return dispositions
		.filter((entry) => entry.disposition !== 'unchanged')
		.map((entry) => ({
			ref: entry.ref,
			name: basename(entry.ref.path),
			disposition: entry.disposition as Exclude<Disposition, 'unchanged'>,
			relocatedPath: entry.relocatedPath,
			presentPath: entry.presentPath,
			...(entry.currentHash ? { currentHash: entry.currentHash } : {}),
		}));
}

/**
 * Compares each of a snapshot's embedded attachments against what is in the vault now.
 *
 *  - `missing`   — nothing at the path; a restore recreates it.
 *  - `unchanged` — the file is present and its bytes equal the snapshot's copy.
 *  - `changed`   — the file is present but its bytes differ.
 *  - `assumedUnchanged` — present and too large to compare cheaply; assumed unchanged.
 *
 * A size mismatch settles `changed` without hashing; only same-size files are read
 * and hashed (see `AttachmentRef.size`).
 */
async function determineAttachmentDispositions(
	app: App,
	recordedSnapshot: RecordedSnapshot,
	currentNotePath: string,
): Promise<AttachmentWithDisposition[]> {
	const out: AttachmentWithDisposition[] = [];
	for (const ref of recordedSnapshot.attachments ?? []) {
		const relocatedPath = relocateAttachmentPath(recordedSnapshot.path, currentNotePath, ref.path);
		// A file at either the relocated home or the recorded one counts as present: the
		// recorded-path check stops a stale copy left by a move from being treated as
		// missing and spawning a duplicate basename Obsidian could then resolve instead.
		const presentPath = (await app.vault.adapter.exists(relocatedPath))
			? relocatedPath
			: relocatedPath !== ref.path && (await app.vault.adapter.exists(ref.path))
				? ref.path
				: null;

		if (presentPath === null) {
			out.push({ ref, relocatedPath, presentPath, disposition: 'missing' });
			continue;
		}

		const currentSize = await fileSize(app, presentPath);
		if (typeof ref.size === 'number' && currentSize !== null && currentSize !== ref.size) {
			out.push({ ref, relocatedPath, presentPath, disposition: 'changed', currentHash: await hashPath(app, presentPath) });
			continue;
		}
		if (typeof ref.size === 'number' && ref.size >= COMPARE_SIZE_CAP) {
			out.push({ ref, relocatedPath, presentPath, disposition: 'assumedUnchanged' });
			continue;
		}

		const currentHash = await hashPath(app, presentPath);
		out.push(
			currentHash === ref.hash
				? { ref, relocatedPath, presentPath, disposition: 'unchanged' }
				: { ref, relocatedPath, presentPath, disposition: 'changed', currentHash },
		);
	}
	return out;
}

/** Byte length of a vault file, preferring a stat over reading the whole file. */
async function fileSize(app: App, path: string): Promise<number | null> {
	const adapter = app.vault.adapter as { stat?: (p: string) => Promise<{ size?: number } | null> };
	if (typeof adapter.stat === 'function') {
		try {
			const stat = await adapter.stat(path);
			if (stat && typeof stat.size === 'number') return stat.size;
		} catch {
			/* fall through to a full read */
		}
	}
	try {
		return (await app.vault.adapter.readBinary(path)).byteLength;
	} catch {
		return null;
	}
}

async function hashPath(app: App, path: string): Promise<string> {
	return hashAttachmentBytes(await app.vault.adapter.readBinary(path));
}

// --- Restoring ---

/** What a restore did to the note's embedded attachments. */
export interface AttachmentRestoreResult {
	/** Attachments recreated because nothing was at their path. */
	recreated: number;
	/** Changed files overwritten with the snapshot's copy, each with the hash they held before — recoverable, since another snapshot still holds that hash. */
	replacedAndRecoverable: Array<{ name: string; previousHash: string }>;
	/** Changed files overwritten even though their previous bytes exist nowhere else — gone for good — basenames. */
	replacedAndNotRecoverable: string[];
	/** Changed files left in place — basenames, for the notice. */
	skipped: string[];
	/** Present-but-unread large files, left as they are — basenames. */
	assumedUnchanged: string[];
}

/**
 * How to resolve a conflict between an embedded attachment's current bytes and the
 * copy a restore would bring back. Only relevant to a *changed* attachment — one
 * present at its path but with different bytes. A missing attachment is always
 * recreated regardless of this choice, and an unchanged one needs no decision at all.
 *
 * `replace` is unconditional: it overwrites every changed attachment the caller
 * passed in, including one whose current bytes exist nowhere else — that copy is
 * then gone for good (see `AttachmentRestoreResult.replacedAndNotRecoverable`). This
 * mode does not re-derive whether that's acceptable; the caller is trusted to have
 * already shown the user exactly which attachments are at risk — `RestorePlan`'s
 * `attachmentsToOverwriteAndUncaptured` is that list — before choosing `replace`, the
 * same trust `restoreSnapshot` already extends to its `dropUnsavedWork` option.
 *
 * Defined here because that conflict is what the values describe; re-exported by
 * `snapshots.ts` as `SnapshotService.restoreSnapshot`'s own mode option.
 */
export type AttachmentConflictMode =
	/** Leave the changed file as it is, whether or not its current bytes are captured elsewhere. */
	| 'skip'
	/** Overwrite the changed file with the snapshot's copy, unconditionally — even if its current bytes exist nowhere else. */
	| 'replace';

/**
 * Applies a previously-computed set of attachment changes for a snapshot being
 * restored. Takes `AttachmentChange[]` as produced by `planAttachmentChanges` —
 * this does not re-scan the vault, so the caller is committing to act on exactly what
 * was already found, not on however things happen to look right now.
 *
 * Missing attachments are always recreated, at the already-resolved `relocatedPath`. A
 * changed file is left alone under `skip`, and unconditionally overwritten under
 * `replace` — `isRecoverable` no longer gates that decision, it only sorts the result
 * into `replacedAndRecoverable` vs. `replacedAndNotRecoverable` for the caller to
 * report honestly afterward.
 */
export async function restoreAttachments(
	app: App,
	store: Store,
	noteId: string,
	attachmentChanges: AttachmentChange[],
	mode: AttachmentConflictMode,
	isRecoverable: (currentHash: string) => boolean,
): Promise<AttachmentRestoreResult> {
	const result: AttachmentRestoreResult = { recreated: 0, replacedAndRecoverable: [], replacedAndNotRecoverable: [], skipped: [], assumedUnchanged: [] };

	for (const entry of attachmentChanges) {
		if (entry.disposition === 'missing') {
			const data = await store.readAttachment(noteId, entry.ref.hash);
			if (data === null) continue;
			await ensureVaultFolder(app, entry.relocatedPath);
			await writeAttachmentBytes(app, entry.relocatedPath, data);
			result.recreated++;
			continue;
		}

		if (entry.disposition === 'assumedUnchanged') {
			result.assumedUnchanged.push(entry.name);
			continue;
		}

		if (mode === 'skip') {
			result.skipped.push(entry.name);
			continue;
		}
		const data = await store.readAttachment(noteId, entry.ref.hash);
		if (data === null) {
			result.skipped.push(entry.name);
			continue;
		}
		await writeAttachmentBytes(app, entry.presentPath!, data);
		if (isRecoverable(entry.currentHash!)) {
			result.replacedAndRecoverable.push({ name: entry.name, previousHash: entry.currentHash! });
		} else {
			result.replacedAndNotRecoverable.push(entry.name);
		}
	}
	return result;
}

/**
 * Writes attachment bytes, preferring the Vault API when Obsidian already tracks a
 * file at `path`. `Vault.modifyBinary` bumps the file's mtime and fires a `modify`
 * event, which invalidates the cached resource URL so an open note re-renders the
 * embed instead of showing the pre-restore image until it is reopened.
 *
 * The adapter fallback covers a path Obsidian has no `TFile` for yet — a
 * just-recreated file, or the test harness.
 */
async function writeAttachmentBytes(app: App, path: string, data: ArrayBuffer): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(normalizePath(path));
	if (existing instanceof TFile) {
		await app.vault.modifyBinary(existing, data);
		return;
	}
	await app.vault.adapter.writeBinary(path, data);
}

/** Creates whatever ancestor folders of `filePath` do not already exist. */
async function ensureVaultFolder(app: App, filePath: string): Promise<void> {
	const dir = filePath.slice(0, filePath.lastIndexOf('/'));
	if (!dir) return;
	let current = '';
	for (const segment of dir.split('/')) {
		current = current ? `${current}/${segment}` : segment;
		if (!(await app.vault.adapter.exists(current))) {
			await app.vault.adapter.mkdir(current);
		}
	}
}

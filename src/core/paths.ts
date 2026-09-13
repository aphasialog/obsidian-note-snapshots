import { normalizePath } from 'obsidian';

/** A path segment must not be able to escape the store: no separators, no traversal. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Builds every path inside the snapshot store. */
export class Paths {
	constructor(private readonly rootSetting: () => string) {}

	root(): string {
		const raw = this.rootSetting().trim();
		return normalizePath(raw.length > 0 ? raw : '.note-snapshots');
	}

	centralManifest(): string {
		return `${this.root()}/central.json`;
	}

	noteDir(noteId: string): string {
		assertSafeSegment(noteId, 'note');
		return `${this.root()}/${noteId}`;
	}

	noteManifest(noteId: string): string {
		return `${this.noteDir(noteId)}/manifest.json`;
	}

	snapshotFile(noteId: string, snapshotId: string): string {
		assertSafeSegment(snapshotId, 'snapshot');
		return `${this.noteDir(noteId)}/${snapshotId}.md`;
	}

	attachmentsDir(noteId: string): string {
		return `${this.noteDir(noteId)}/attachments`;
	}

	/** Named by content hash: identical bytes are stored once and names can never collide. The original extension is dropped — the hash is the only lookup key. */
	attachmentFile(noteId: string, hash: string): string {
		assertSafeSegment(hash, 'attachment');
		return `${this.attachmentsDir(noteId)}/${hash}.bin`;
	}

	/** True for paths inside the store, which must never be snapshotted themselves. */
	isInternal(path: string): boolean {
		const root = this.root();
		return path === root || path.startsWith(`${root}/`);
	}
}

function assertSafeSegment(segment: string, kind: 'note' | 'snapshot' | 'attachment'): void {
	if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
		throw new Error(`Unsafe ${kind} path segment: ${JSON.stringify(segment)}`);
	}
}

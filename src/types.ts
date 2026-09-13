/** Schema version stamped into every manifest we write. */
export const SCHEMA_VERSION = 1;

// --- central.json: one global manifest, one entry per note ---

export interface CentralManifest {
	/** Schema version this manifest was written as. See SCHEMA_VERSION. */
	schemaVersion: number;
	notes: Record<string, CentralEntry>;
}

export interface CentralEntry {
	/** Same concept as NoteManifest.latestPath, duplicated here so a note can be found by path without opening its manifest. */
	latestPath: string;
	/** UTC ISO timestamp of when this entry was last written. */
	updatedAt: string;
	/** UTC ISO timestamp of when the note was deleted, if it was. History is kept until purged. */
	orphanedAt?: string;
}

// --- manifest.json: one per note, holding many snapshots ---

export interface NoteManifest {
	/** Schema version this manifest was written as. See SCHEMA_VERSION. */
	schemaVersion: number;
	noteId: string;
	/**
	 * Where the live note currently sits in the vault, as of the last snapshot,
	 * restore, or detected rename. Display and recovery only — never identity, and
	 * distinct from any individual snapshot's own SnapshotMetadata.path.
	 */
	latestPath: string;
	/** UTC ISO timestamp of when this note's history was first created. */
	createdAt: string;
	/** The id of the snapshot the working file currently matches, or null if it matches none. */
	activeSnapshotId: string | null;
	/** Keyed by snapshot id — the same ids used as activeSnapshotId and SnapshotMetadata.parent. */
	snapshots: Record<string, SnapshotMetadata>;
}

// --- A note's snapshots, each embedding zero or more attachments ---

/** Metadata for one stored snapshot. Content lives in a sibling file. */
export interface SnapshotMetadata {
	/**
	 * UTC ISO timestamp of when the snapshot was taken, and the key everything is
	 * ordered by. Clamped to stay strictly after the previous snapshot, so a backwards
	 * clock cannot reorder history.
	 */
	ts: string;
	/** Content hash. An index only — equality is always confirmed by comparing content. */
	hash: string;
	/** Byte length of the stored content. */
	size: number;
	/** Optional user-supplied label. */
	name?: string;
	/** Optional free-text note about the snapshot. Annotation only. */
	message?: string;
	/**
	 * The snapshot the note was checked out to when this snapshot was taken. Recorded
	 * for lineage only — there is no branching UI, and history is sorted by ts, not by
	 * this field. Captured now so the information is recoverable if that changes later.
	 */
	parent?: string;
	/**
	 * Vault path the note had when this snapshot was taken. A display hint in the
	 * history and the reference point for placing recreated attachments; never
	 * identity, and not compared for snapshot dedup.
	 */
	path?: string;
	/** When set, this snapshot is protected from deletion (single and bulk). */
	locked?: boolean;
	/** Attachments this snapshot's content embeds, backed up so restoring is self-contained. */
	attachments?: AttachmentRef[];
}

/** A snapshot plus its id, ready for display. */
export interface SnapshotRow extends SnapshotMetadata {
	snapshotId: string;
	/**
	 * 1-based position among the note's snapshots, oldest = 1. Recomputed on every
	 * read for display only, so deleting a snapshot renumbers the rest.
	 */
	n: number;
}

/** A backed-up attachment a snapshot's content embeds. Blobs are content-addressed. */
export interface AttachmentRef {
	/** Vault path the attachment lived at when this snapshot was captured. */
	path: string;
	/** Content hash of the attachment's bytes; also the store's lookup key. */
	hash: string;
	/**
	 * Byte length of the attachment's content. A cheap pre-check on restore: a file
	 * whose size differs has certainly changed, so only same-size files are hashed.
	 * Absent on refs written before this field existed — treat as "size unknown".
	 */
	size?: number;
}

// --- Others: runtime-only types, not part of any on-disk schema ---

/**
 * Whether the working file matches a stored snapshot.
 *
 * Note text only — it says nothing about embedded attachments. An attachment changed
 * in place can still read as `clean` here.
 */
export type WorkingState =
	/** The content is already in the history, as snapshot `snapshotId` (display number `n`, optional label). */
	| { kind: 'clean'; snapshotId: string; n: number; name?: string }
	| { kind: 'unsaved' }
	| { kind: 'untracked' };

export interface SnapshotOutcome {
	row: SnapshotRow;
}

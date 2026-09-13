import type { App, TFile } from 'obsidian';

const NOTE_ID_KEY = 'ns-id';

// --- Public API ---

/**
 * Resolves the note's Note Snapshots id, preferring the metadata cache but falling
 * back to the file's raw bytes when the cache might be stale.
 *
 * The metadata cache lags behind external writes (sync, git checkout), and the
 * move-versus-copy test in `identity.ts` must not misclassify on stale data.
 */
export async function readNoteId(app: App, file: TFile): Promise<string | null> {
	const cached = normaliseId(rawIdFromCache(app, file));
	if (cached) return cached;
	try {
		const head = (await app.vault.cachedRead(file)).slice(0, 4096);
		return normaliseId(rawIdFromFrontmatterText(head));
	} catch {
		return null;
	}
}

/** Writes (or overwrites) the id in the note's frontmatter, creating the block if needed. */
export async function writeNoteId(app: App, file: TFile, noteId: string): Promise<void> {
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		frontmatter[NOTE_ID_KEY] = noteId;
	});
}

// --- Private helpers ---

/** The raw `ns-id` frontmatter value from the metadata cache only, unvalidated. */
function rawIdFromCache(app: App, file: TFile): unknown {
	return app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_ID_KEY];
}

/** The raw `ns-id` value from a leading YAML block, unvalidated. No full YAML parse. */
function rawIdFromFrontmatterText(text: string): string | null {
	if (!text.startsWith('---')) return null;
	const end = text.indexOf('\n---', 3);
	const block = end === -1 ? text : text.slice(0, end);
	const match = new RegExp(`^${NOTE_ID_KEY}:\\s*(.+)$`, 'm').exec(block);
	if (!match?.[1]) return null;
	return match[1].trim().replace(/^["']|["']$/g, '');
}

function normaliseId(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

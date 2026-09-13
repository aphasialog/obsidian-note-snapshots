import { diffLines, diffWordsWithSpace } from 'diff';

/** A run of text within a diff row, emphasised when it is the part that actually changed. */
export interface DiffSegment {
	text: string;
	/** True for the words that differ between the paired lines; false for shared context. */
	emphasis: boolean;
}

export interface DiffRow {
	kind: 'add' | 'del' | 'ctx';
	/** 1-based line number on the "before" side, or null for an added line. */
	oldNumber: number | null;
	/** 1-based line number on the "after" side, or null for a removed line. */
	newNumber: number | null;
	segments: DiffSegment[];
}

export interface DiffResult {
	rows: DiffRow[];
	addedLines: number;
	removedLines: number;
	/** True when the two texts are identical, i.e. there is nothing to show. */
	identical: boolean;
}

/** A `diff` change part, narrowed to the fields we use. */
interface Change {
	value: string;
	added?: boolean;
	removed?: boolean;
}

/**
 * A line-level diff of two texts, enriched with word-level emphasis inside modified
 * lines and with a running line number for each side.
 *
 * Pure and DOM-free so it can be unit-tested; the modal turns the rows into elements.
 */
export function buildDiffRows(before: string, after: string): DiffResult {
	const parts = diffLines(before, after) as Change[];
	const rows: DiffRow[] = [];
	let oldNumber = 1;
	let newNumber = 1;
	let addedLines = 0;
	let removedLines = 0;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;

		// Unchanged span: both sides advance together, no word-level diff needed.
		if (!part.added && !part.removed) {
			for (const line of toLines(part.value)) {
				rows.push({ kind: 'ctx', oldNumber: oldNumber++, newNumber: newNumber++, segments: plain(line) });
			}
			continue;
		}

		// Added/removed span: `diffLines` emits a removed part immediately before its
		// paired added part, so take both together and line them up word by word.
		const removed = part.removed ? toLines(part.value) : [];
		const next = parts[i + 1];
		const added = part.removed && next?.added ? toLines(next.value) : part.added ? toLines(part.value) : [];
		if (part.removed && next?.added) i++;

		const pairable = removed.length > 0 && added.length > 0;
		removed.forEach((line, index) => {
			const other = pairable ? added[index] : undefined;
			rows.push({
				kind: 'del',
				oldNumber: oldNumber++,
				newNumber: null,
				segments: other === undefined ? plain(line) : wordSegments(line, other, 'del'),
			});
		});
		added.forEach((line, index) => {
			const other = pairable ? removed[index] : undefined;
			rows.push({
				kind: 'add',
				oldNumber: null,
				newNumber: newNumber++,
				segments: other === undefined ? plain(line) : wordSegments(other, line, 'add'),
			});
		});
		addedLines += added.length;
		removedLines += removed.length;
	}

	return { rows, addedLines, removedLines, identical: addedLines === 0 && removedLines === 0 };
}

/**
 * Splits a change's text into lines, dropping the empty element a trailing newline
 * produces so it does not render as a phantom blank row.
 */
function toLines(value: string): string[] {
	const lines = value.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** One unchanged span, the common case for a row with no intra-line diff. */
function plain(text: string): DiffSegment[] {
	return [{ text, emphasis: false }];
}

/**
 * Word-level segments for one side of a modified line pair. `keep` picks which half
 * of the word diff to render: the removed words for the old line, added for the new;
 * shared words are carried through on both sides.
 */
function wordSegments(oldLine: string, newLine: string, keep: 'del' | 'add'): DiffSegment[] {
	const segments: DiffSegment[] = [];
	for (const part of diffWordsWithSpace(oldLine, newLine) as Change[]) {
		if (keep === 'del' && part.added) continue;
		if (keep === 'add' && part.removed) continue;
		const emphasis = Boolean(part.added || part.removed);
		const last = segments[segments.length - 1];
		if (last && last.emphasis === emphasis) last.text += part.value;
		else segments.push({ text: part.value, emphasis });
	}
	return segments.length > 0 ? segments : plain('');
}

const FALLBACK_PREFIX = 'f1-';

let warnedAboutFallback = false;

// --- Public API ---

/**
 * Hashes note content for use as a lookup index.
 *
 * Prefers SHA-256. The fallback is not collision-resistant, which is safe here
 * because callers confirm a hash match by comparing the actual content — the hash
 * only narrows the candidate set.
 */
export async function hashNoteContent(content: string): Promise<string> {
	const sha = await sha256Hex(new TextEncoder().encode(content));
	if (sha) return sha;
	return FALLBACK_PREFIX + cyrb64(content, 0) + cyrb64(content, 0x9e3779b9) + content.length.toString(36);
}

/**
 * Hashes binary content (attachment bytes) for use as a content-addressed store key.
 * Same algorithm and fallback behaviour as {@link hashNoteContent}.
 */
export async function hashAttachmentBytes(bytes: ArrayBuffer): Promise<string> {
	const sha = await sha256Hex(bytes);
	if (sha) return sha;
	const byteArray = new Uint8Array(bytes);
	return FALLBACK_PREFIX + cyrb64Bytes(byteArray, 0) + cyrb64Bytes(byteArray, 0x9e3779b9) + byteArray.length.toString(36);
}

/**
 * True when two hashes were produced by different algorithms, so a mismatch tells
 * us nothing about whether the content differs.
 *
 * On supported platforms `crypto.subtle` is always available, so a note should never
 * hold mixed-algorithm hashes; this only ever fires if SHA-256 failed mid-lifetime.
 */
export function algorithmsDiffer(a: string, b: string): boolean {
	return a.startsWith(FALLBACK_PREFIX) !== b.startsWith(FALLBACK_PREFIX);
}

// --- Private helpers ---

/** Tries SHA-256 via `crypto.subtle`; null if it's unavailable or throws. */
async function sha256Hex(data: BufferSource): Promise<string | null> {
	const subtle = activeWindow.crypto?.subtle;
	if (!subtle) {
		warnFallback('crypto.subtle unavailable');
		return null;
	}
	try {
		return toHex(new Uint8Array(await subtle.digest('SHA-256', data)));
	} catch (error) {
		warnFallback('SHA-256 unavailable', error);
		return null;
	}
}

function warnFallback(message: string, error?: unknown): void {
	if (warnedAboutFallback) return;
	warnedAboutFallback = true;
	if (error !== undefined) console.warn(`Note Snapshots: ${message}, using fallback hash.`, error);
	else console.warn(`Note Snapshots: ${message}, using fallback hash.`);
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** cyrb53-style 64-bit-ish mixer. Fast, non-cryptographic. */
function cyrb64(text: string, seed: number): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).padStart(13, '0');
}

/** Byte-oriented twin of {@link cyrb64}, so hashing a large buffer never builds a string first. */
function cyrb64Bytes(bytes: Uint8Array, seed: number): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] ?? 0;
		h1 = Math.imul(h1 ^ b, 2654435761);
		h2 = Math.imul(h2 ^ b, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).padStart(13, '0');
}

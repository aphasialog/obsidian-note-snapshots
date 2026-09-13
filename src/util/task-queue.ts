/**
 * Serialises async work per key.
 *
 * Two types of keys are in use in this plugin:
 *
 *  - `CENTRAL_QUEUE_KEY` (see store.ts) — serialises writes to the single shared
 *    central.json.
 *  - `noteId` — each note has its own key, so its own queue: every read-modify-write
 *    of that note's manifest.json goes through it, so two concurrent saves (say, an
 *    autosave and a manual restore) can't race and clobber each other. A rename or
 *    move can never split that queue, since the key is identity, not path.
 *
 * Failures do not poison the chain — the next task runs regardless.
 */
export class TaskQueue {
	private readonly tails = new Map<string, Promise<void>>();

	run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = previous.then(work);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			// Only clear if no one queued behind us.
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return result;
	}
}

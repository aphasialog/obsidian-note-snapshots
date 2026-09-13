# A lean per-file snapshot plugin for Obsidian

**Status:** implemented (sections 1–8), §2a and §2b included — each snapshot records its full path at capture
time as a display and recovery hint, restore is a pure content checkout (it never renames or moves the note),
and a snapshot carries the note's embedded attachments: missing ones are recreated relative to where the note
lives now, and a changed-in-place one is put back after a prompt (§2b).

**Scope.** Per-file snapshots only. Folder-level snapshot and restore are deliberately **not** supported;
§9 explains why.

I tried a few of Obsidian's existing per-file version-control plugins first, but my use case turned out a bit
special — I want to keep short, clean history and have attachments backed up. This design is built around those
two ideas:

- **History never balloons.** Restore is a *checkout*, not a commit — it writes the stored content and moves a
  pointer, so flipping between V1 and V2 fifty times leaves two snapshots, not fifty-two. §1 explains why a naive
  restore-as-commit design doesn't stay bounded, and how this one does.
- **The note is the unit.** A snapshot captures the note *and* the attachments it embeds, so a restore brings
  back the whole thing even if an image was deleted or edited since. §2b covers capture and recreation.

## Design goals

- **Small and focused.** About 2,000 lines across ~15 files, with a single runtime dependency (`diff`).
- **Plain TypeScript over Obsidian's own primitives** — `ItemView` / `Modal` / `Menu` — no state-management
  framework, no local database, no worker pool.

## 1. Why restore is a checkout, not a commit

A design where "restore" is just another write — append a new version holding the old content — doesn't stay
bounded: toggling between two snapshots N times can write up to N new ones, since each restore is itself an event
the dedup logic has to reason about after the fact. Comparing only against the latest version doesn't fully close
the gap either — alternating between two versions still grows the history, because the content being backed up
matches an *older* version, not the latest one.

Trace with `V1` holding content *A*, `V2` holding content *B*, file currently at *B*:

| Click | Naive: restore writes a new version | This design: restore moves a pointer |
| --- | --- | --- |
| restore V1 | `+ V3(B)` | `head = V1` |
| restore V2 | `+ V4(A)` — **grows** | `head = V2` |
| restore V1 | `+ V5(B)` — **grows** | `head = V1` |
| …×100 | + 100 snapshots | still 2 snapshots |

## 2. Core design — restore is a checkout

1. **Restoring never creates a snapshot.** It writes the stored content to the file and moves a pointer.
   Toggling between snapshots is free, forever.
2. **Every snapshot records a content hash.** A snapshot is a no-op if that content already exists *anywhere* in
   the note's history, not just at the tip — the gap left by comparing only against the latest version (§1).
   Renaming or moving a note is not by itself a change — only the bytes are compared. The interactive
   *Save snapshot* dialog shows which snapshot the note already matches; every user-invoked save then records
   one anyway (`allowDuplicate`), identical or not, so an explicit request is never silently dropped. Only
   restore's automatic backup (R4) keeps the no-op, firing when the working content matches no stored snapshot.
3. **The note manifest carries `head`** — the snapshot id the working file currently matches. It drives the
   "current" marker in the list, and makes "is there unsaved work?" a hash comparison rather than a guess.
4. **One auto-snapshot, one condition.** Restore backs up the working file only when its hash matches *no*
   stored snapshot, i.e. there is genuine unsaved work that would otherwise be lost. Named
   `Unsaved changes before restore`. It cannot fire twice for the same state.

Consequence worth confirming: after restoring `V1` and editing, the next manual snapshot becomes the newest
snapshot — history stays a flat list. We store `parent: <head id>` as metadata so lineage is recoverable later,
but ship no branching UI.

The `V1`, `V2`, … labels are **display only** — a snapshot stores no sequence number. The sidebar sorts by
timestamp and numbers 1..k on every render, so deleting `V2` from `(V1, V2, V3)` leaves `(V1, V2)` with the old
`V3`'s content.

Timestamps are UTC (`toISOString()`), so a time-zone change never reorders anything — the stored instant is
absolute and the lexicographic sort on those strings is chronological. A *backwards clock* (NTP correction,
manual change) could, so `commit()` clamps each new `ts` to `max(now, latest existing ts + 1ms)`: strictly
increasing, order preserved, the label off by at most the size of the skew.

### 2a. A snapshot records where the note lived, but restore never changes it

Implemented. Each snapshot stores the note's full vault path at capture. It is a **hint only** — shown in the
history, and used as the reference point for placing recreated attachments (§2b). Restore is a pure content
checkout: it never renames or moves the note, and the no-op check never compares the path.

**How it works:**

- Each `SnapshotMeta` carries `path?: string` — the note's full vault path when `commit()` ran. Optional:
  snapshots written before this shipped have none. Nothing branches on its value except attachment relocation.
- `restore()` writes content, recreates missing attachments, and moves `head`. It does not call `renameFile` and
  has no `renamedTo` / `renameBlockedBy` outcome — a restore that would have changed the note's name or folder
  under the old design is now just a content write, and the confirmation prompt follows `confirmRestore` with no
  override.
- Snapshot dedup (R2) and the "current" indicator (R3) compare **content only**. Renaming or moving a note
  produces no snapshot on its own; the same bytes are the same snapshot wherever the file sits. `findByContent`
  takes no predicate.
- Identity is still the `ns-id`, never the path — a manual rename is handled by `Identity.handleRename` exactly
  as before, and the stored `path` is repaired lazily for display.

> **Decision: restore never renames or moves the note — content-only.** With §2b recreating missing attachments
> relative to the note's *current* folder, the note no longer needs to move for embeds to resolve, so the only
> thing a restore-time rename bought was putting the old *name* back — a choice better left to the user, who may
> well have renamed on purpose.

Deliberately not done: restore offers no "put the old name back" affordance; the recorded `path` is never
surfaced for the user to act on beyond the history display.

### 2b. A snapshot carries the note's embedded attachments

Implemented. A snapshot is the note plus the files it embeds, so restoring a note whose image was later deleted —
often by an unrelated "find orphaned files" cleanup — brings the image back too.

**How it works:**

- `captureAttachments` scans the snapshot content for embeds (`![[wikilink]]` and `![](path)` forms), resolves
  each through Obsidian's own link resolution (with a root/relative fallback for the test harness), and stores
  the bytes. Note-to-note embeds (`.md`) are skipped — those carry their own history.
- Blobs are content-addressed at `attachments/<hash>.bin` under the note's store, deduplicated within the note:
  an image embedded unchanged across forty snapshots is written once. Each `SnapshotMeta` carries
  `attachments?: { path, hash, size? }[]` — `path` being the attachment's full vault path at capture, `size` its
  byte length (a cheap divergence pre-check on restore; absent on refs written before the field existed).
- On restore, `applyRestoredAttachments` classifies each of the target's attachments against the vault now:
  **missing** (recreate), **match** (leave), **divergent** (present, different bytes), or **unchecked** (present,
  over 25 MB — assumed unchanged rather than re-hashed every restore). A size mismatch settles *divergent*
  without hashing; only same-size files are read and hashed.
- A **divergent** file is overwritten only when the restore mode allows it (`replace` or `snapshot-first`) *and*
  its current bytes still exist in some snapshot of the note — `canOverwrite` checks `snapshotRefFor`, so the
  plugin never destroys the only copy of anything. The default mode (`skip`) recreates missing attachments and
  leaves divergent ones, reporting them in `RestoreOutcome.staleAttachments`.
- `SnapshotService.planRestore` runs the same classification read-only, ahead of the prompt, splitting divergent
  files into `safe` (current bytes traced to a snapshot via `snapshotRefFor`) and `atRisk` (nowhere else). The
  UI (`main.decideRestore` / `promptAttachmentRestore`) turns that into one `ChoiceModal`:
  - `atRisk` non-empty (with or without an unsaved body) → **Snapshot & restore** (default) takes one
    backup snapshot covering the body *and* every current embed, then overwrites; **Restore text only** skips.
  - only `safe` divergence → **Replace attachments** (default) overwrites with no backup; **Restore text only**
    skips.
  - no divergent embeds but the note body is unsaved work → `promptRestoreOverUnsaved`: **Snapshot & restore**
    (default) keeps the R4 backup; **Restore only** passes `discard`, which skips the R4 backup so the unsaved
    text is dropped.
  - `Confirm before restoring = Never` forces `skip` with no prompt.
- `restore(file, id, { attachments })` forces the one backup in `snapshot-first` mode even when the body already
  matches a snapshot, so a changed embed's current bytes are captured before the overwrite. One backup covers
  every at-risk file at once. The result feeds a single notice (`describeRestoreOutcome`) naming where replaced
  bytes remain; `snapshotRefFor` prefers that backup, then the newest snapshot holding the hash.
- This is self-resolving: the first restore past an edited-but-uncaptured attachment defaults to
  *Snapshot & restore*, which lands those bytes in a snapshot, so every later restore between those snapshots
  treats the file as `safe` and stops prompting.
- Each blob is recreated **relative to where the note lives now**, not at its recorded absolute path
  (`relocateAttachmentPath`). If the note has moved folders since capture, an attachment that sat *at or below
  the note's own folder* (`image.png` beside it, `attachments/image.png` under it) is re-homed under the current
  folder so the same embed still resolves; an attachment with an absolute home (vault root, a fixed custom
  folder) keeps its recorded path, since a note move must not drag it around. When the note has not moved, the
  two are identical. This is what lets restore (§2a) leave the note's location entirely alone.
- Embeds resolve after this in complementary cases: `![[wikilink]]` always (basename resolution —
  location-independent as long as the name is unique); relative `![](path)` when the target sat at or below the
  note's folder, so it relocates with the note; and the **non-standard** "Absolute path in vault" form
  `![](/assets/img.png)` when the target sat *outside* the note's folder, so it keeps the recorded path the
  leading-slash link points at (the resolver's root/relative fallback strips the leading slash at capture). The
  gaps: a relative embed that escapes the note's folder, and an absolute-in-vault embed whose target was under
  it. See the README's "When attachment recovery falls short".
- A guard skips recreation when the attachment is still present at *either* the relocated home or its recorded
  path, so a stale copy left behind by a move cannot spawn a duplicate basename that Obsidian then picks up.
- Missing ancestor folders are created; a hash with no stored blob is skipped rather than treated as fatal,
  so a partial backup degrades instead of aborting the restore.

Deliberately not done: attachments linked but not embedded are not captured; a restore never *deletes* a file
the target does not embed, only overwrites a divergent one the user opted into; embeds are matched by exact
`path` between snapshots (a rename of the attachment reads as remove + add in the row delta). Blobs orphaned by
a snapshot deletion are garbage-collected by `gcAttachments` on every deletion path (`removeSnapshot`,
`removeAllSnapshots`) once no surviving snapshot references the hash.

## 3. Storage

```
# plain files in the vault — syncable, greppable, recoverable by hand
.note-snapshots/
  central.json                # noteId -> { path, updatedAt }  (rename tracking, orphan cleanup)
  <noteId>/
    manifest.json             # { noteId, head, snapshots: { <id>: { ts, hash, size, name?, message?, parent?, path?, locked?, attachments?: { path, hash, size? }[] } } }
    <snapshotId>.md            # raw content, uncompressed
    attachments/<hash>.bin    # embedded non-note attachments, content-addressed, deduplicated within the note (§2b)
```

- **Snapshot metadata.** Each `snapshots` entry records `ts` (the clamped UTC capture time, §2), the content `hash`
  and byte `size`, the optional `name` / `message`, the `parent` head at capture, the note's `path` at capture (a
  display and attachment-relocation hint, §2a), `locked`, and the `attachments` list (§2b). The `hash` only
  narrows a content lookup — equality is always confirmed against the actual bytes. `head` is the snapshot id the
  working file currently matches, or absent when it matches none; the `V1`, `V2`, … labels shown in the sidebar
  are derived by sorting on `ts` at render time and never stored.
- **Note identity:** a `ns-id` frontmatter key, written lazily on the first snapshot only — untouched notes stay
  untouched. Survives rename and move, which a path key does not.
- **No compression, no IndexedDB.** Snapshots are readable markdown; a corrupted manifest loses the index, never
  the content.
- **Serialisation:** a ~20-line per-note promise chain replaces `p-queue`. Vault events fire reentrantly, so
  this is load-bearing, not ceremony.

## 4. Rename, move, and copy

The design goal: **identity is never derived from the path**, so a rename is a cache update, not a migration.
`ns-id` is a random uuid living in the note's frontmatter; `.note-snapshots/<noteId>/` is keyed by it. The `notePath`
in `central.json` is a derived convenience — used for display and orphan detection — and is allowed to go stale.

| Event | What happens | Cost |
| --- | --- | --- |
| Rename or move inside Obsidian | `vault.on('rename')` updates `notePath` in `central.json` | one small JSON write |
| Rename outside Obsidian (git, Dropbox, `mv`) | No event fires. `ns-id` travels inside the file, so history is found the next time the note is opened; `central.json` self-heals then | lazy, zero-touch |
| Folder rename | Child paths change without per-file events in some cases; identity is unaffected, only the path cache goes stale | self-heals on next open |
| Copy / duplicate a note | Two files now claim one `ns-id` — **must fork**, see below | new id for the copy |
| Change extension (`.md` → `.txt`) | Obsidian stops parsing frontmatter, so `ns-id` becomes unreadable | falls back to path lookup |
| Annotate a *snapshot* | `name` / `message` fields in `manifest.json`; no content, no id, no file touched | metadata write |

### The move-vs-copy discrimination

When a note's `ns-id` resolves to a `notePath` that is not the file's current path, there are two possible
causes and they need opposite responses. The test is whether the recorded path still exists:

- **Recorded path is gone → it was a move.** Update `notePath`. History follows the note.
- **Recorded path still exists → it was a copy.** The file whose path differs from the record is the newcomer:
  mint a fresh `ns-id`, write it to the copy's frontmatter, and give it an empty history. The original keeps
  everything.

This is deterministic and does not depend on mtime ordering — the discrimination never needs to guess which file
is "newer."

### Why identity stays path-independent

Two structural consequences of keying everything off `noteId` rather than path:

- **The per-note lock is keyed on `noteId`, not path**, so a rename cannot split a lock mid-operation — the
  operations on either side of a rename stay the same operation throughout, with nothing that needs a
  "rename in progress" guard.
- **Correctness does not depend on catching the rename event.** Missing one costs a stale path label until the
  next open, never orphaned history. A path-keyed scheme doesn't have that fallback — missing the event there
  loses the history outright.

## 5. Scope

**Build**

- Per-file snapshot history
- Manual snapshots, each with an optional name and a free-text note (`message`), edited together afterwards
- Sidebar list with the current snapshot marked
- Restore as checkout
- Embedded attachments captured with the snapshot, missing ones recreated on restore (§2b)
- Diff: snapshot ↔ current, snapshot ↔ snapshot
- Edit a snapshot's name and note; delete a snapshot
- Lock a snapshot against deletion; delete one snapshot, or every unlocked snapshot at once

**Not supported** — folder snapshot / restore. Section 9 explains why it is a net loss.

**Drop**

- In-file branching + branch manager
- Keystroke-level edit history
- Writing stats + heat map
- Timeline search
- Export / bundling manager
- Compression + worker pools
- Redux Toolkit, RTK Query, React, Radix, Framer Motion
- Dexie / IndexedDB mirror

## 6. Phases

| # | Deliverable | Done when |
| --- | --- | --- |
| 0 | Scaffold: `manifest.json`, `tsconfig`, esbuild config, dev copy into a test vault | Empty plugin loads and unloads cleanly in Obsidian |
| 1 | Storage layer: paths, manifests, hashing, note identity, per-note lock | Snapshot and read-back verified by hand on a scratch note |
| 2 | Commands + sidebar view: save, list, restore, delete, rename | Toggling V1↔V2 fifty times leaves exactly two snapshots |
| 3 | Diff views | Diff renders for a 5k-line note without blocking the UI |
| 4 | Hygiene: lock/unlock, orphan cleanup on delete, rename/copy handling, attachment capture (§2b) | Deleting a note leaves no `.note-snapshots` residue; duplicating a note that has snapshots yields two independent histories; a snapshot of a note with a since-deleted image restores the image |

**Shipped deviation.** Deleting a note *marks* its history orphaned instead of purging it. Destroying history the
instant a file is deleted is not recoverable, whereas Obsidian’s own delete is. Removal is never automatic: the
user runs **Clean up history of deleted notes** (a command, or the settings button), which permanently deletes
the orphaned histories older than a configurable window (30 days by default; `0` keeps them all). An earlier
build ran this cleanup once on every startup — dropped, so the plugin never deletes stored history without an
explicit action.

## 7. Decisions

| Question | Options | Decision |
| --- | --- | --- |
| **Note identity** | frontmatter `ns-id` / path-keyed manifest | **frontmatter**, written lazily. Path keys silently orphan history when a note is renamed outside Obsidian. |
| **Auto-snapshot** | none / debounced on save / interval | **none.** Intentional snapshots are the feature — the plugin doesn't decide on the user's behalf when their work is worth keeping. |
| **Retention** | unlimited / cap per note | **unlimited, no automatic cap.** Same reasoning as auto-snapshot: this plugin is about intentional operations, so it doesn't decide for the user which of their own snapshots to discard. The user manages history by hand — lock a snapshot to protect it, delete one, or clear every unlocked snapshot at once. |
| **Storage folder** | `.note-snapshots` / visible `note-snapshots` | **`.note-snapshots`** — hidden from file explorer and search. Caveat below. |
| **A copied note** | fork with empty history / fork and clone the history / share one history | **fork, empty history.** Cloning duplicates every snapshot on disk for a note the user may not care about; sharing would let two independent files silently write into the same history. Forking is recoverable — the original still has everything. |

## 8. Risks

- **Dot-folders and third-party sync.** Obsidian Sync handles `.note-snapshots`, but some Git/Drive setups skip
  dotfolders by default — history would silently not replicate. Mitigation: make the path a setting, document it.
- **Hashing on mobile.** `crypto.subtle` needs a secure context; if it is unavailable in the mobile webview,
  fall back to a small pure-JS hash. Decide by measuring, not assuming.
- **Frontmatter writes.** A malformed YAML block makes the `ns-id` write fail. There is no
  YAML-specific handling for this — the rejection propagates up to the top-level command
  handler's generic catch, which surfaces a "Could not save a snapshot" notice. Untested.
- **`RestorePlan` is the committed proposal, not a disposable preview.** `restoreSnapshot`/`backupAndRestoreSnapshot`
  take `plan` as their input and execute against `plan.attachmentChanges` directly rather than re-scanning the
  vault a second time — `planRestore` is only ever called once. Re-deriving dispositions at restore time would
  guard against neither "provably safe" (there is still a gap between any fresh read and the write that follows
  it) nor "faithful to what the user consented to" (a fresher read can show something the user never saw and
  agreed to), and within one device nothing else can mutate the vault while the confirmation modal blocks input.
  Whether a changed attachment is *recoverable* is not safety-critical either way: `restoreAttachments`'s `replace`
  mode overwrites a changed attachment unconditionally once chosen — the caller is trusted to have already shown
  the user which ones are at risk, via `plan.attachmentsToOverwriteAndUncaptured`, the same trust `dropUnsavedWork`
  already gets. Recoverability only decides how the outcome is *reported* afterward (replaced-and-recoverable vs.
  gone for good), so `executeRestore` re-derives it live specifically when `backupAndRestoreSnapshot`'s own forced
  backup could have made a hash newly captured within the very call in progress — getting that stale would only
  mislabel the notice, never cause a wrong overwrite. The only realistic way for `attachmentChanges` itself to go
  stale between plan and commit is another device syncing changes in behind it — an edge case treated as the
  user's own responsibility to manage, not something this plugin defends against.

## 9. Why folder operations are not supported

There is no "snapshot this folder" or "restore this folder", and there will not be. The plugin stores no
folder-level content, so a folder snapshot could only ever be a **batch wrapper over per-file histories** — and
that batching costs far more than it returns.

- **A mistaken folder snapshot is expensive to undo.** One click would write a snapshot into dozens or hundreds
  of per-file histories at once. There is no honest "undo that batch" to match it: the user has to open every
  file and delete its snapshot by hand. The per-file model has no accidental blast radius of that size.
- **A shared snapshot label across files is a fiction.** "V3 of the folder" reads like it means something, but
  every file is snapshotted independently — its own numbers, its own locks and deletes, its own restores.
  Holding one coherent label across many histories that diverge as files are added, removed, renamed, and
  individually reverted is a large amount of state and UI for what is really just "snapshot these N files at
  once".
- **Restore has no honest default.** Restoring a folder to an earlier state either deletes files created since —
  destroying data the plugin never tracked — or leaves them, in which case it is not really "the folder as it
  was".

The recommendation is the same as for a single note: snapshot the files you care about, one independent history
each. Capturing several at once is just several snapshots — which keeps every history separate and every undo
local.

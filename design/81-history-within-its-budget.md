# 81 — Saved file history within its budget

Status: **built** 2026-09-29 (`checkpoint-maintenance.js`, `git-objects.js`,
`sqlite-compact.js`, changes in `checkpoint-store.js`, `file-archive.js`;
`test/checkpoint-retention.test.js`). Amends design/36 (storage and
concurrency) and design/35 (archive limits).

## The problem

On 2026-09-28 the checkpoint store reached its 1 GiB budget and stopped
saving: every step showed "Checkpoint gap: Checkpoint storage budget
reached". Nothing was ever removed (design/36 said so), and the budget
measured only a third of the store:

| on disk | size | counted |
|---|---:|---|
| file contents, one zlib file each | 1.0 GB | yes |
| trees and commits, one small file each | 0.4 GB | no |
| metadata: each snapshot's full file list as JSON | 1.6 GB | no |

The file lists duplicated the Git trees built from them. The per-file
archive (design/35) had the same flaw and had been full since 2026-09-24.

## What was chosen

**Store compactly first; remove history only when that is not enough.**

1. *A snapshot's file list is its Git tree.* The metadata keeps only the
   files that could not be saved (binary, too large, protected), compressed
   (`format = 2`). Reading a snapshot walks its tree through one long-lived
   `git cat-file --batch` per repository with trees cached by hash
   (`git-objects.js`); consecutive snapshots share nearly all trees. Older
   full lists are replaced only after they match their tree exactly;
   a list that disagrees is left as it is (`format = 1`, still readable).
2. *Compaction.* Each repository is repacked from what the metadata still
   refers to: the commits of its snapshots and the blobs of its target
   versions, without walking commit parents. Git stores successive versions
   of a file as differences. Everything else (unreferenced objects, the old
   `refs/heads/checkpoints` chain and `refs/target-blobs/*`, abandoned
   temporary indexes) is removed. Snapshot commits no longer have parents
   and no refs exist: a metadata row is the only thing that keeps an object.
3. *An honest budget.* `CHATTERING_CHECKPOINT_MB` (1024) now counts the
   whole store: each repository as measured at its last compaction, plus
   what was written since, plus the metadata file.
4. *Oldest first, as a safety net.* Above 80% after compaction, the oldest
   quarter of what may be removed goes, round by round, until below 60%.
   A snapshot's age is its most recent use by a boundary. **Never removed:**
   the last `CHATTERING_CHECKPOINT_KEEP_HOURS` (24); the newest snapshot of
   each folder and newest version of each targeted file; everything a
   review points at once a person has commented, ticked a file or sent
   feedback (and the reviews it stands on). If only protected history is
   left over budget, saving stops with a message saying so and naming the
   setting to raise.
5. *Removal is explained.* Boundaries of a removed snapshot keep their row
   with `error = "Removed to free space (saved history from before DATE was
   cleared)"`; `checkpoint_removed` lets any later read say the same instead
   of "not found". Reviews show the gap with that reason.
6. *Freed database space goes back to the disk.* The first time, one
   `VACUUM` converts the file to incremental auto-vacuum; afterwards
   `PRAGMA incremental_vacuum`. Both run in a worker thread.

The per-file archive gets the same policy (`FileArchive.retain`): its budget
counts pages holding data; each file's newest version, the last day and
versions a reviewed review points at stay; removed versions say why.

Measured on this machine's store (a copy, 2026-09-29): 3.2 GB → 490 MB with
no history removed, 0 mismatches over ~500 sampled snapshots (file lists and
file bytes) and 200 target versions; about three minutes once, then ~30 ms
per check when there is nothing to do.

## Rejected

- **Only raising the budget.** Postpones the same stop; the store would
  still triple-count nothing and keep growing forever.
- **Compressing the full file lists.** 1.6 GB → 325 MB; the tree makes the
  same information almost free (the unsaved-file lists compress to 9 MB).
- **Time Machine–style thinning** (keep one snapshot per day for old
  history). A review needs the *pair* around a step; thinning breaks pairs
  everywhere instead of removing whole old periods.
- **`git gc` / `git prune`.** Git and the metadata would be two sources of
  truth for what is alive, and git's reachability would race captures in
  other processes. The metadata decides; git only packs what it is told.

## Concurrency (captures run in the server and in every Pi worker)

Leases in `checkpoint_leases`, with expiry so a crashed process never
blocks anyone:

- `capture` (per folder): held from the start of a capture until its
  boundary row names what was saved; many at once.
- `exclusive` (per folder, or `*`): waits until the folder's captures end,
  then holds new ones off (they wait up to a minute; past that the step is
  recorded with the reason). Held only for the short destructive steps:
  deleting rows, packing what was captured during the long pack, swapping.
- `maintain` (one for the store): a second maintainer does nothing.

The long pack runs without the exclusive lease; a `.keep` file marks it
while stragglers are packed. Invariants: an object row exists only for an
object on disk (the file is written before its row; both go together under
the exclusive lease). Each folder has a `generation` that maintenance bumps
whenever it removes objects; a process drops its remembered file→object ids
when the generation changes. Destructive steps re-check that their lease
is still held.

## Operating

- Only the server maintains, and only the server upgrades a store that
  holds history (a Pi worker loads code from disk and may be newer than the
  server that started it). It checks one minute after start, every 15
  minutes, and at once when one of its own captures finds the store full
  or a folder due for compaction. `CHATTERING_CHECKPOINT_MAINTENANCE=0`
  turns automatic maintenance off.
- The last report is in `checkpoint_meta` under `last-maintenance`.
- Processes started before this version cannot write snapshots into the
  new schema (one more column) until they restart.

## Not done

- No settings screen shows the store's size or lets a person pin history.
- Windows cannot move a pack another reader holds open; it stays, whole,
  until the next compaction.
- Artifact folders full of changing binary files (video frames) do not
  shrink with deltas; they are most of what remains on this machine.

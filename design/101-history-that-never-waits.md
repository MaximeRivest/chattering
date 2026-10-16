# 101 — File history that never holds the agent

Status: **built** 2026-10-16 (`checkpoint-store.js`, `checkpoint-extension.js`,
`server.js` artifact declaration and conversion, `preview.js` fallback;
`test/checkpoint-budget.test.js`). Amends design/36 (limits), design/67
(versions of binary assets) and design/81 (the lease wait).

## The problem

On 2026-10-16 a conversation in scholarsreadinglist showed, at every step,
"File history did not save this step: Checkpoint scan exceeded 15 seconds"
and "… exceeds 200 MiB of eligible files", stopping took half a minute, and
sending was slower than before. From the store's own records, since
2026-10-13 that folder had hit the 15-second limit about 1,900 times and the
200 MiB one about 2,000 times; bigspin and segbench failed the same way.

Causes, in order of weight:

1. **Showing one file versioned its whole folder.** `artifact` on
   `figurer/runs/index.html` made `figurer/runs/` an artifact scope, saved at
   every step with its pictures and data. scholarsreadinglist had 60 such
   folders: 63 GB, 41 GB, three of about 5 GB (one a separate repository).
   Its own files were 427 files, 18 MB.
2. **The limits were found by doing the work.** The scan read, hashed and
   stored files until the running total passed 200 MiB or 15 s had gone, then
   threw away the snapshot. Each failure cost the whole limit and left up to
   200 MiB of stored objects nothing referred to, filling the store.
3. **Every copy held the agent.** The turn's start (before the model was
   even asked), each step's start and end, each open step at a stop and the
   turn's end were all awaited by Pi. A stop waited for one copy per open
   step plus one more; Pi's `abort()` waits for `agent_settled` handlers.
4. **Waits had no bound.** A copy waited up to 60 s while maintenance held
   the store, and behind other copies of the same folder.
5. One growing log made a whole step fail ("File changed during checkpoint
   scan"), and a file deleted between listing and reading failed it too.

## What was chosen

**Save what a person reviews, decide limits before reading, and give the
agent's wait a hard budget.**

### What a step saves

- The project's files as before (Git's view: tracked and not ignored, text
  up to 2 MiB). Logs (`*.log`) never: they change at every step and nobody
  reviews them. More binary kinds are recognised without being read.
- **An artifact that is a file**: the file and the files it names, followed
  three levels (HTML/CSS/SVG/JS/Markdown, and a `deck.json`): `src`, `href`,
  `srcset`, `url()`, Markdown links, quoted names with an extension
  (`fetch('data.json')`). At most 300 files and 50 MB per page. A name a
  script assembles at run time is not found.
- **An artifact that is a folder**: whole while it holds at most 1,000 files
  and 50 MB (an app, a deck). Past that, only its page (`index.html`,
  `deck.json`, `index.md`…) and what the page names, and the person is told
  once per conversation. A folder found too large is not walked again for
  five minutes.
- **All artifacts of a project share 100 MB per step**, the most recently
  shown first; one that does not fit is saved as its page, or left out with a
  note. The project's own files keep the rest of the 200 MB.
- Artifacts shown more than 30 days ago are no longer followed; showing one
  again follows it again.
- Folders recorded the old way are converted once by the server after its
  first scan: each becomes what conversations actually showed there (from
  the index), and a folder nobody is known to have shown is dropped.

### Limits before reading

A capture lists everything (Git's listing, approved folders, artifacts)
and looks at each file's size (lstat, synchronously in batches of 256 with a
yield between) before reading any. Over 20,000 files or 200 MB, it stops
there, saying how much and where most of it is ("239 MB … (110 MB in
results/)"), having stored nothing. Then only files whose fingerprint changed
are read. A file that changes while it is read is left out of that step
("Changing while it was being saved"); the rest is saved.

When nothing changed since the process last saved the folder (a step's end
and the next step's start), the snapshot is the same and is not rebuilt: no
Git process is started. Its row is checked first, since maintenance may have
removed it.

### The agent's wait

- **Only a step's start holds the agent**, at most **2 s**
  (`CHATTERING_CHECKPOINT_WAIT_MS`), waiting in line and for maintenance
  included. Stopping the run stops that wait at once (Pi's signal).
- The turn's start, a step's end and the turn's end run **behind** the
  agent, during the model's next answer, with **10 s**
  (`CHATTERING_CHECKPOINT_BEHIND_MS`). Sending and stopping wait for none.
- The turn's end is **one** copy, which also closes every step the stop
  left open (several boundary rows, one snapshot).
- Copies of one process keep the order they were asked in (one gate finds
  each copy's root after the previous one's), so a step's end is always
  saved before the next step's start. Closing a conversation waits for the
  copies still running.
- Work done before a deadline is kept (fingerprint cache, stored objects):
  a large first save completes over the next steps instead of failing at
  every one.
- A warning is shown once per reason per turn (reasons that differ only in
  their numbers count as one); a stopped step is not a warning.

## Measured (2026-10-16, machine under load 40–160)

| folder | before | now, warm | now, new conversation |
|---|---|---|---|
| scholarsreadinglist | failed, 15 s or 200 MiB, every step | 150–270 ms | — |
| segbench | failed, 200 MiB, every step | 55 ms | 0.6 s |
| chattering | 410 ms average, tail to 9 s | 80 ms | 0.5 s |
| bigspin | failed, ~9 s average | 70–100 ms | — |

## Trade-offs

- **Old versions of output files are not kept** unless an artifact page
  names them, and its pictures only as far as the page names them. Review
  changes still shows the current files and the code that made them; an
  artifact version shows the current file, marked `live-fallback`, where the
  version lacks one.
- **A step whose start is not saved within 2 s has no "before"**: its review
  says the step was not saved. Expected only on the first steps of a project
  never saved before (every new file is written once, each synced to disk;
  measured 20–40 s for 1,000–2,000 files on the loaded machine), which the
  copies made behind the agent mostly absorb.
- A step's end is saved during the next model call, not before it. Nothing in
  the conversation writes in between; another program writing at that
  moment is attributed the same way as before (design/88).
- The 30-day window, the 100 MB allowance and the per-folder limits are
  numbers, not measurements of what a person needs; the notes say when they
  apply.

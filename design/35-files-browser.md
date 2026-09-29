# Files browser: implementation status

## Direction

Replace the global conversation/files lens with Conversation / Files inside a
conversation. Keep the existing project summary. Its Files tab opens the same
browser, without a conversation filter. GitHub-style browsing and review are the
visual reference; the primary history axis is recorded time, not branches.

## Implemented

- `files-browser.js` and `files-browser.css`: folder listings, breadcrumbs,
  repository selector, literal filename/content search, README preview with an
  Edit & run entry into the existing MRMD workspace.
- Conversation/File switching preserves the conversation draft and reading
  position. In-page return to Files remembers the open file and its browser
  context. File routes carry conversation context for refresh/deep links.
- Browse / Changes navigation. Time selection: previous Files visit, this
  conversation, last X events, hour, day, custom endpoints. Actor filters;
  unknown filesystem activity stays unknown, not attributed to a human.
- Changes uses lazy-loaded comparisons of available snapshots. Unified and
  side-by-side layouts, collapsed unchanged context, individual activity list,
  conversation links, explicit review and independent flags.
- Review applies to the exact selected set of event IDs. Adding older events
  to a selection cannot inherit approval merely by sharing its newest event.
  Flags are file-scoped. Both are browser-local, not server/shared state.
- Live edits the current file. `file-history-drawer.js` replaces the old
  keyframe strip with a chronological, read-only history drawer: pick a saved
  version, step older/newer, or compare two versions. Return to Live remounts
  the editor. Historical snapshots and hidden timelines are no longer eagerly
  fetched while opening a live file.
- `file-archive.js` durably stores compressed, content-addressed observations,
  including editor saves, observed external writes, deletions and recreation.
  Editor/watcher activity links to exact saved before/after IDs when available,
  rather than guessing those endpoints from timestamps. The archive is outside
  the activity cache and note index, with owner-only directory/file permissions.
- New activity never replaces a review or clean editor automatically; refresh
  and reload are explicit. The existing ask-for-a-change run lifecycle still
  locks its editor and reloads after that run settles.
- `files-browser-server.js`: bounded directory/content search, project-scoped
  SQL activity queries, containment checks. Server routes validate project and
  repository membership before browsing. Search skips dependency directories,
  symlinks and binary contents; results state when incomplete. Files larger
  than 512 KiB are not content-searched; filename search still finds them.

## Not implemented yet (do not present these as delivered)

1. Full-project browsing as of an arbitrary moment. The browser lists live
   files; selecting a time range controls activity highlighting/comparison.
2. Selected-range inline editor decorations, including human/external changes.
   Existing editor trust/reload markers are separate.
3. Shared flags in this time-filtered Changes view. The new checkpoint-backed
   tool-group reviews do store comments and reviewed status on the server; see
   [checkpoint reviews](36-checkpoint-reviews.md).
4. Direct editing/running inside the folder README preview. Edit & run opens
   the same document in MRMD instead of mounting a second editor in Browse.

## Archive limits and operating choices

- Default durable store: `~/.local/share/chattering/file-history/versions.sqlite`.
  Back up this directory; deleting the activity cache does not delete it.
  `CHATTERING_FILE_HISTORY_DIR` overrides the private directory,
  `CHATTERING_FILE_HISTORY_MB` changes the default 512 MiB database budget,
  and `CHATTERING_NO_FILE_HISTORY=1` disables capture. SQLite journal overhead is
  additional to the database budget. Above 80% of it, the oldest versions are
  removed (design/81); each file's newest version, the last day and versions
  a reviewed review points at stay.
- At capacity or on capture failure, file editing continues. Save responses,
  activity notices and the history drawer report warnings; prior versions are
  kept. A binary/oversized file records an unavailable marker, not an empty file.
- Only text up to 2 MiB is captured. Filesystem observations come through the
  existing watcher/debounce and cannot record every rapid intermediate write.
  Initial observation starts when watched/seeded or opened; no invented past.
- Historical copies can contain subsequently removed secrets. The archive is
  local, not encrypted, and persists until explicitly removed. Its directory
  has mode 0700 and the database 0600.
- The drawer lists the newest 2000 saved observations per file (plus Git/agent
  points). Explicitly requested older version IDs remain readable and valid in
  snapshot URLs; the full archive is retained. Timeline pagination remains open.
- Archive observations are not currently used to rebuild the activity cache's
  event-to-snapshot links after that cache is deleted. Saved History remains
  available independently, while reconstructed activity may lose exact links.

## Accuracy rules

- A Git or live snapshot is exact for that version, not proof that it matches
  a requested arbitrary timestamp. Show actual comparison endpoints.
- Replayed agent snapshots remain explicitly reconstructed. Missing baselines
  produce an unavailable message, never an empty invented file.
- If a range ends in activity without a saved version, comparisons may use the
  live file and must say it is not the selected endpoint.
- Actor filters select events/files, not authorship of every line between two
  whole-file snapshots. This distinction is visible above Changes.
- Active-conversation badges describe the conversation, not a claim that a
  particular file is currently being written.

## Verification

`node --test test/file-archive.test.js test/files-browser.test.js test/file-workspace-navigation.test.js test/fileledger.test.js test/conversation-app.test.js test/conversation-scroll.test.js test/document-bundle.test.js`

The Chromium integration test covers actual server/browser navigation, content
search, Markdown/code editor mounting, draft preservation, remembering the open file,
editor-save activity and a combined diff, review/flag persistence, saved history
reading/comparison, live-editor return, actual external writes/deletion/recreation,
immutable earlier snapshots, and phone width. Archive unit tests cover reopening,
blob deduplication, private permissions, file-scoped snapshot access, distinct
unavailable/deleted/empty states, timestamp ordering, and capacity exhaustion. Unit tests cover folder listings, search, binary/dependency exclusions,
traversal and symlink escapes, capped results, scoped activity, and route/range
helpers. Browser test fixtures use an isolated temporary directory under the
home directory because `/tmp` is intentionally classified as loose conversations.

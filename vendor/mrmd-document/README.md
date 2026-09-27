# Vendored: mrmd-document

The light MRMD document editor bundle. It gives chattering the MRMD
markdown writing experience: blur→render / focus→source editing,
tables, images, task lists, math, alerts, syntax-highlighted code
blocks, and MRMD themes.

It excludes: runtimes, terminals, linked tables, AI panels, and MRP
clients. Chattering owns files, saves, Git commits, and provenance; MRMD
owns the editing surface.

## Current artifact

- Version: 0.24.0 (entry `src/document-entry.js`, global `mrmdDocument`)
- 0.24.0: rich displays. A run's result is an ordered series of output
  blocks, images and embeds (`<iframe class="rat-output" … sandbox>` for
  interactive pages: plotly, htmlwidgets); `setCellOutput(cell, text,
  {parts})`, the runner's `transport.displayUrl` and `saveOutputs`, the
  run panel's `appendFrame`, and owned embeds rendered as sandboxed frames.
- 0.23.0: Julia code blocks (```julia, ```jl) and .jl files are coloured,
  as R and Python blocks already were.
- 0.22.0: `review.accept(pos)` / `review.reject(pos)` — the change at a place
  (default: the cursor), for voice commands ("accept", "reject").
- 0.21.0: `lineWrapping` option and `setLineWrapping(on)` in both editors.
  Chattering: code and text files wrap as the device says (live-file.js
  "how files look": Alt+Z, the ⋯ menu, Settings → appearance); text size
  and the documents' font are host CSS custom properties read by the theme
  (`--editor-font-family`, `--editor-font-size` in mrmdHostTheme).
- 0.20.0: AI commands in the whole-file editor (`createCodeEditor({ai:
  {…, scope, language}})`): the box, the ✦, suggest or review, outcomes,
  keyHelp. Without a selection a command acts on the outermost syntax
  construct at the cursor that fits 12 000 characters (comments above it
  included; a one-line construct gives way to the lines up to blank lines);
  in plain text (`scope: 'prose'`), the paragraph. Chattering passes the
  file's surface (ai-commands.js `surfaceOf`) and its language name.
- 0.19.0: reviewing changes in the text, in both editors (`editor.review`,
  document-review.js on @codemirror/merge): a proposal (`review.propose`,
  or everything during `review.capture` — Chattering captures an ask's run)
  shows against the text before it, old lines struck through above the new
  ones, which stay editable; Accept / Reject on each, a panel under the text
  (accept all, reject all, next/previous; Alt-y, Alt-n, Alt-Shift-y,
  Alt-Shift-n, Alt-] / Alt-[). Other edits never show as changes (copied
  into the original). `review.onResolved` gives per region the text before,
  proposed and kept (Chattering: ai-outcomes.js → /api/ai-feedback).
  `updateContent(text)` reaches a text by the smallest changes. AI commands:
  `ai.mode` (suggest | review, switched in the box), "Edit in text", and
  `ai.onOutcome` for every command. Tokens `--mrmd-review-inserted` /
  `--mrmd-review-deleted` (the binary e-ink theme sets them transparent).
- 0.18.0: AI commands can be found without knowing a key. A ✦ in a narrow
  gutter of its own on the cursor's line (while the editor has focus and
  commands can act there) opens the command box on a click; faint at rest,
  lit for a selection or an open box, pulsing while an answer is written,
  lit when it is ready. Rest opacity is the token `--mrmd-ai-spark-rest`
  (Chattering's binary e-ink theme sets 1). Suggestion buttons show their
  keys; a box opened without Mod-j names it. `editor.keyHelp()` reports the
  editor's keys that act here, now (the open box, exclusive; a suggestion;
  the cell or document at the cursor), and `mrmdDocument.formatKey(name)`
  spells a CodeMirror key name — Chattering's `?` help (`fileEditorHelp`)
  shows them.
- 0.17.0: AI commands (`ai`, document-ai.js). A command box at the cursor
  (Mod-j; the ✦ on a code cell; `openAiMenu()`): typing filters the host's
  commands, and text that names none becomes the instruction of the host's
  instruction command. The answer streams in as a suggestion beside the
  text — ghost text for a short insertion, a panel with a word diff for a
  replacement — and is not document text until accepted (Tab with the
  cursor in the range, or the button): one transaction, userEvent
  `input.ai`, `aiEditAnnotation`, its own undo step, refused if the text
  changed. Escape discards; Alt-] / Alt-[ step through answers ("Another"
  asks again). Editing inside the suggested range discards it. The host
  lends `run(request, {signal, onText})` and may `beforeAccept` (awaited;
  `event.result()` is the document as it will be), `onAccept`, `notify`,
  `escalate`. Never on the YAML header or a ```output block.
  `findFrontmatterRange` is exported from block-decorations.js for it.
- 0.16.1: host completion shows. `setLanguageServices({complete})` never
  displayed an answer in either editor (a new completion source per
  lookup made CodeMirror drop each answer and ask again). Chattering uses
  it for code cells: completion from the notebook's running kernel.
  0.16.0 was never served and is removed.
- 0.16.0: one rat adapter. `mrmdDocument.ratNotebook` (src/rat-notebook.js,
  plain functions, also vendored by the VS Code extension) is what a run on
  rat means: output cleaning, plot markers, the result format, which result
  a cell owns, matching another client's run to its cell, following `rat
  events`. `mrmdDocument.createNotebookRunner(editor, {transport, runnable,
  hooks})` runs cells the same way in every host: status, live panel with
  plots, prompts, the result under the cell where it is now (never over
  code edited during the run), run all, and other clients' runs (drawn on
  their cell, kept with a note, not saved; Stop interrupts the kernel).
  Result format: program output only, a fence longer than any backtick run
  inside (was: such lines indented), plots as `![plot](…/_assets/generated/
  <hash>.png)` after the block; a result owns only images a run made, so a
  person's image under it survives a rerun. `setCellOutput(cell, text,
  {images})`. The live panel gains `appendImage`, `finish`, a no-dim mode.
- 0.15.0: cell controls. With `onRunCell`, every runnable cell (the host's
  `runnableLanguages`; default any named language but output and diagrams)
  carries a `▶ Run` button at the right of its fence row, and the host
  draws the cell's run state with `setCellStatus(cell, {state, startedAt,
  ms, label})` or, better, the run's own `run.setStatus(...)` (the live
  panel follows its cell through edits): `queued`, `running` (elapsed time
  in whole seconds, a bar pulsing down the cell's left side and sliding
  along its top edge), `waiting` (for input — the bar holds still), then
  `ok`/`error` with the duration, kept until the cell's code is edited.
  Busy cells show `■ Stop` → `onCancelCell(cell, {state})`.
  `clearCellStatuses(states)` clears marks (run all's queue). The live
  panel is hidden while it has nothing to show. Motion stops under
  prefers-reduced-motion. The bundle grows by about 8 KB.
- 0.14.0: live cell runs. `showCellRun(cell)` puts a panel under a running
  cell: `append(text)` shows output as it streams (carriage returns redraw
  a progress line in place, ANSI styling dropped, links clickable), and
  `ask({prompt, secret})` shows a field for the program's input prompt — a
  password field when `secret` — resolving `{text}`, `{dismissed: true}`
  (Esc: the host stops the run) or `{withdrawn: true}` (`dismissInput()`,
  a newer question, or `dispose()`). The panel is a view decoration, never
  document text: no save, undo step or collaboration traffic while a cell
  runs; the result block the cell already owns is dimmed until the host
  writes the new one (`setCellOutput`) and calls `dispose()`. Chattering
  feeds it from `rat run --events` (runDocCell in app.html). The bundle
  grows by about 5 KB.
- 0.13.0: diagram fences drawn through a host renderer. `createDocumentEditor`
  accepts `diagrams: {languages, render}`; a closed fence in a named language
  is drawn while the cursor is outside it and shown as source inside, like
  display math. The bundle ships no diagram library: chattering lends its
  vendored mermaid (`mermaidDiagramNode` in app.html), so documents draw the
  same diagrams as transcripts and notes, with the same theme. Drawings are
  cached by source; `refreshDiagrams()` redraws after a theme change. The
  `file-link-navigate` event now reports the click's modifier keys
  (`detail.modifiers`), which the file workspace uses for Ctrl/Cmd-click.
  The bundle grows from 1.7 MB to 1.71 MB.
- 0.12.0: collaboration primitives under `mrmdDocument.collab` (`Y`,
  `Awareness`, `WebsocketProvider`, `yCollab`, `yUndoManagerKeymap`), and
  both `createDocumentEditor` and `createCodeEditor` accept `extensions`
  (extra CodeMirror extensions), so a host can make an editor shared with
  `extensions: [collab.yCollab(ytext, provider.awareness)]`. Nothing is
  wired by the bundle: the host owns document identity, the endpoint and
  who is who. Chattering's `collab.js` speaks the y-websocket protocol on the
  server side. The bundle grows from 1.6 MB to 1.7 MB.
- 0.11.0: shared host services for both document and code editors: an opt-in
  Markdown marker gutter, `onLineHover`, version-checked `setLineMarks`,
  `setDiagnostics`, `setLanguageServices`, and `openSearch`. Code editors retain
  native language completions and gain explicit word completion / Tab handling.
  Completion/hover requests are cancelled and stale results rejected after edits
  or disposal. This is an integration boundary, not a bundled language server.
  The bundle grows by only a few KiB; it still uses one CodeMirror instance.
- 0.10.1: cache document scans by immutable document identity (and syntax-tree
  identity for parser-dependent ranges). Cursor movement within a line reuses
  block decorations; scrolling decorates only visible code-block lines.
  Sequential table/admonition scans avoid repeated line lookups. Ordinary
  documents skip linked-table parsing and math-free documents skip math's
  syntax traversal. Source mode retains its existing styling and spacing.
  See [performance and verification](performance-0.10.1.md).
- 0.10.0: `createCodeEditor(target, {doc, filename, theme, readonly,
  onChange, onSave, onMarkClick})` — whole-file code editing on the same
  engine and theme object as the document editor: line numbers, a language
  picked from the file name (`fileLanguage(name)`: js/ts, python, html,
  css, json, sql, yaml, r, shell, rust, go, c/c++, java, xml, toml, lua,
  ruby, dockerfile, diff, markdown), search, and a host-marked gutter
  (`setLineMarks({line: {glyph, title, cls}})` for trust and provenance).
  Both editors gain `selection()` (1-based lines, selected text) and
  `gotoLine(n)`. Chattering's files mode uses this instead of its old textarea
  overlay. The bundle grows from 1.3 MB to 1.6 MB (the compiled-language
  grammars).
- 0.9.4: notebook mechanics. `setCellOutput(cell, text)` writes an
  ```output fence under the cell (whitespace-only-gap ownership rule —
  a rerun replaces only the block it owns; empty output removes it;
  one undo step; stale-cell guard). `listCells()`, `advanceToNextCell()`,
  Shift-Enter → onRunCell(cell, {advance:true}). Code-block line classes
  now carry data-lang so hosts can style ```output blocks as results.
- 0.9.3: a selection overlay layer (drawn ABOVE line fills, color
  `--mrmd-selection-overlay`) so selections stay visible over code-block
  grounds; `onRunCell` option (Mod-Enter in a fenced block → the host
  gets `{lang, code, from, to}`) and `codeBlockAtCursor()` — the editor
  detects cells, the host owns execution and output UI.
- 0.9.2: the renderer adds unstyled line classes so hosts can restyle
  whole rows: `cm-md-heading-line` / `cm-md-h<n>-line` on headings and
  `cm-md-codeblock-line` / `-first` / `-last` on fenced code. Chattering
  uses them to give the editor the conversation `.md` look (rule under
  h1/h2, boxed code blocks).
- 0.9.1: `createDocumentEditor` and `setTheme` accept a theme OBJECT.
  Chattering passes a theme built from its own tokens (`mrmdHostTheme()` in
  app.html); every value is a `var()` reference into tokens.css, so the
  editor follows light, dark, custom, and binary e-ink themes.
- Source: `/home/maxime/Projects/mrmd-packages/mrmd-editor`
- Source commit: `ded726d` ("document entry 0.22.0").
- SHA-256: `e8f66e42fd8ed891bbe7a46b4f09076630bb7a877891c5e6455f7c299ac845b2`
- License: MIT (see `0.13.0/LICENSE`)
- Deployment: restart the server **after active runs finish**, then reload
  clients. Until the new static route is available, the loader falls back to
  0.21.0 (everything but accepting or rejecting one change by voice: "all"
  still works). Keep that artifact and route while the fallback exists.
  0.20.0 and older are no longer loaded; delete their folders and routes
  once 0.22.0 has run for a few days.

## Features enabled in chattering

- `createDocumentEditor(target, options)` — hosted-mode editor
- `getContent` / `setContent`
- `onChange` (2 s Markdown autosave debounce) / `onSave` (host-owned: focused
  editing saves to disk; the legacy document workspace can create Git revisions)
- `setLineMarks(marks, expectedContent?)`, `onLineHover(line)` and
  `onLineHoverEnd()` for host-owned gutter annotations
- `setLanguageServices({complete, hover, definition})`,
  `setDiagnostics(items, expectedContent)`, `openSearch()`; no LSP processes
  are started by the bundle
- `setTheme` / `getThemeNames` — MRMD themes, applied inline on the host
- `setSourceMode` — raw markdown toggle
- `setReadonly`
- `assetResolver` — relative image paths resolve through chattering's API
- `diagrams` — mermaid fences drawn with chattering's vendored mermaid;
  `refreshDiagrams()` after a theme change
- `file-link-navigate` — links inside the document open in the file
  workspace (filesmode.js `fileWsWireDocLinks`)
- `createNotebookRunner` — every cell run (app.html `createDocRunner`: the
  transport over /api/doc/run-cell, run-input, cancel-run, kernel, plot,
  plots; other clients' runs from /api/doc/follow on the tab's event stream)
- `ai` — AI commands (app.html `docAiOptions`; the catalog and prompts in
  ai-commands.js; /api/doc/ai, /api/doc/ai-accept in server.js)
- `keyHelp()` / `formatKey` — the document's live keys in the `?` help and
  the pinned corner hint (app.html `fileEditorHelp`)
- `review`, `updateContent` — an ask's changes reviewed in the text
  (filesmode.js `fileWsBeginRun` / `fileWsRunEvent`), AI command answers in
  review mode, and the outcomes recorded (ai-outcomes.js)
- cell controls (`runnableLanguages`, `onCancelCell`, `run.setStatus`,
  `clearCellStatuses`) — Run/Stop on each cell and its run state
  (app.html `runDocCell`, `runAllDocCells`, `cancelDocCell`)
- `showCellRun` — a running notebook cell's live output and input prompts
  (app.html `runDocCell`, fed by `rat run --events` through
  `/api/doc/run-cell` with `stream: true` and `/api/doc/run-input`)

## Update procedure

1. In `mrmd-editor`: pull, review, then `npm run build:document`.
2. Run `npm test` and `npm run test:document`; for shared renderer changes,
   also `npm run build && npm run test:render`. `npm run bench:document`
   measures typing/cursor costs (set `MRMD_BUNDLE` to compare an older build).
   On NixOS set `PUPPETEER_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium`.
3. Copy `dist/mrmd-document.iife.min.js` to a NEW versioned folder here
   (`vendor/mrmd-document/<version>/`).
4. Update the SHA-256, commit hash, and version in this README.
5. Add the new static route in `server.js`, point `MRMD_DOC_SRC` in `app.html`
   at it, and retain the previous path as `MRMD_DOC_FALLBACK_SRC` during rollout.
   Run `node --test test/document-bundle.test.js` in chattering.
6. Delete older version folders only after they are no longer referenced by
   the loader/fallback and the new version has run for a few days.

Build command reference:

```bash
cd /home/maxime/Projects/mrmd-packages/mrmd-editor
npm run build:document
sha256sum dist/mrmd-document.iife.min.js
```

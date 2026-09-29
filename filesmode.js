'use strict';
// filesmode.js — the file editor's lifecycle: mounting the MRMD document
// editor or the CodeMirror code editor into the live file view, saving,
// reloading, disk-change banners, and "ask for a change" (an agent run
// started from the open file). The frame around the editor is live-file.js;
// browsing is files-browser.js; recorded changes are change-review-ui.js.
//
// Loaded before app.html's main script; every helper it needs (router,
// the MRMD editor mount, toasts) is a global of that script, resolved at
// call time.

async function openConversationAtEvent(key, eventId) {
  let entryId = null;
  try {
    const d = await (await fetch('/api/files/entry?key=' + encodeURIComponent(key) + (eventId ? '&event=' + encodeURIComponent(eventId) : ''))).json();
    entryId = d.entryId || null;
  } catch {}
  return open(key, entryId ? 'entry:' + entryId : undefined);
}

// Old links: a project's files page is the files browser.
async function showFilesProject(name, opts = {}) {
  if (name) return showFilesBrowser(name, opts);
}

// ---- the open file ----
let fileWs = null;
let fileWsSeq = 0;

const MD_EXT = /\.(md|markdown|qmd|rmd|mdx)$/i;
function fileWsKind(p) {
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(String(p || ''))) return 'image';
  if (/\.(mp4|m4v|webm|ogv|mov)$/i.test(String(p || ''))) return 'video';
  if (/\.pdf$/i.test(String(p || ''))) return 'pdf';
  return MD_EXT.test(String(p || '')) ? 'md' : 'code';
}
function fileWsHash(ws) {
  const parts = ['file'];
  if (ws.project) parts.push('p=' + encodeURIComponent(ws.project));
  // The app dispatcher decodes the whole hash before parsing file parameters.
  // One extra layer keeps '&' inside context values from becoming separators.
  if (ws.browserContext) parts.push('browser=' + encodeURIComponent(encodeURIComponent(JSON.stringify(ws.browserContext))));
  if (ws.back) parts.push('back=' + encodeURIComponent(encodeURIComponent(ws.back)));
  parts.push('focus');
  if (ws.htmlPreviewOpen) parts.push('preview=1');
  // A line a link asked for is part of the route. ws.line holds it until
  // fileWsAfterMount has moved the cursor, and the hash written on open keeps
  // it, so a reload or a shared link lands on that line, not the top.
  const line = Number(ws.line);
  if (Number.isInteger(line) && line > 0) parts.push('line=' + line);
  if (ws.reviewRef) parts.push('review=' + encodeURIComponent(encodeURIComponent(JSON.stringify(ws.reviewRef))));
  if (ws.mode === 'history' && ws.historySel?.to) parts.push('to=' + encodeURIComponent(ws.historySel.to), 'from=' + encodeURIComponent(ws.historySel.from || ws.historySel.to));
  parts.push('path=' + (ws.path || ''));
  return parts.join('&');
}
// `file&p=…&focus&from=…&to=…&path=/abs` (path last: it may contain &)
// and the short `file=/abs`. `landing` is an old flag, ignored.
function parseFileHash(h) {
  if (h.startsWith('file=')) return { path: h.slice(5) };
  const out = {};
  const at = h.indexOf('&path=');
  if (at >= 0) { out.path = h.slice(at + 6); h = h.slice(0, at); }
  for (const seg of h.split('&').slice(1)) {
    if (seg === 'landing' || seg === 'focus') continue;
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq), v = seg.slice(eq + 1);
    try { out[k === 'p' ? 'project' : k] = decodeURIComponent(v); } catch { out[k === 'p' ? 'project' : k] = v; }
  }
  if (out.line) out.line = Number(out.line);
  return out;
}

// ---- links inside the open document ----
// The MRMD bundle turns `[text](target)` into a span that swallows the click
// and dispatches `file-link-navigate` with the raw target; http(s) links are
// real anchors and never arrive here. A target is document-relative, exactly
// like an image handed to `assetResolver`: it resolves against the open file,
// the server checks it (existence and the usual path policy), and it opens in
// this editor with a way back. `#L12` or `#12` names a line; any other
// fragment is a heading, matched the way GitHub slugs it.
function parseFileLinkTarget(target) {
  let t = String(target || '').trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1); // [x](<a b.md>)
  t = t.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, ''); // [x](a.md "title")
  let fragment = '';
  const hash = t.indexOf('#');
  if (hash >= 0) { fragment = t.slice(hash + 1); t = t.slice(0, hash); }
  t = t.split('?')[0];
  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };
  return { path: decode(t), fragment: decode(fragment) };
}
// `..` never climbs above the root; `~/` is left for the server to expand.
// Windows paths ("C:\\x\\doc.md", "C:/x") resolve the same way, their drive
// kept as the root; results use forward slashes, which the server accepts.
function resolveDocRelative(docPath, target) {
  if (!target || target.startsWith('~/')) return target || '';
  const t = String(target).replace(/\\/g, '/'), doc = String(docPath).replace(/\\/g, '/');
  const drive = /^[A-Za-z]:\//.test(t) ? t.slice(0, 2) : /^[A-Za-z]:\//.test(doc) && !t.startsWith('/') ? doc.slice(0, 2) : '';
  const strip = p => drive && p.slice(0, 2).toUpperCase() === drive.toUpperCase() ? p.slice(2) : p;
  const absolute = t.startsWith('/') || /^[A-Za-z]:\//.test(t);
  const out = absolute ? [] : strip(doc).split('/').slice(0, -1).filter(Boolean);
  for (const seg of strip(t).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return (drive || '') + '/' + out.join('/');
}
function headingSlug(value) {
  return value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
}
// The 1-based line of the heading a fragment names, or null. YAML front
// matter and fenced code are skipped; ATX and setext headings count;
// repeated headings get -1, -2…, the way GitHub numbers duplicate anchors.
function findHeadingLine(text, fragment) {
  const seen = new Set(), rows = String(text).split(/\r?\n/);
  let fence = null, frontmatter = rows[0]?.trim() === '---';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (frontmatter) { if (i > 0 && /^(---|\.\.\.)\s*$/.test(row)) frontmatter = false; continue; }
    const fenced = row.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenced) {
      const token = fenced[1];
      if (!fence) fence = token;
      else if (token[0] === fence[0] && token.length >= fence.length && !fenced[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = row.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const setext = !atx && row.trim() && !/^\s/.test(row) && /^ {0,3}(=+|-+)\s*$/.test(rows[i + 1] || '');
    const heading = atx?.[1] || (setext ? row : null);
    if (heading === null) continue;
    const base = headingSlug(heading);
    let slug = base, n = 0;
    while (seen.has(slug)) slug = `${base}-${++n}`;
    seen.add(slug);
    if (fragment === slug || fragment === heading) return i + 1;
  }
  return null;
}
// undefined when the target could not be read; null when it has no such heading.
async function fileWsHeadingLine(pathValue, fragment) {
  try {
    const d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: pathValue }))).json();
    return d.error ? undefined : findHeadingLine(d.text, fragment);
  } catch { return undefined; }
}
async function fileWsFollowLink(ws, target, { system = false } = {}) {
  if (fileWs !== ws || !ws.path) return;
  const link = parseFileLinkTarget(target);
  if (!link.path) return; // a bare #fragment stays in this document
  const wanted = resolveDocRelative(ws.path, link.path);
  let out;
  try { out = await postJson('/api/path/exists', { paths: [wanted] }); }
  catch { out = { error: 'could not check the link · ' + link.path }; }
  if (fileWs !== ws) return;
  if (out.error) return errToast(out.error);
  const found = out.found && out.found[wanted];
  if (!found) return errToast('link target not found · ' + link.path);
  // Ctrl/Cmd-click means the system application, as it does on every file
  // control in the app.
  if (system) return runNativePathAction({ key: '', path: found.path }, 'open');
  if (found.kind !== 'file') return fileWsOpenFolder(found.path, link.path);
  let line = null;
  const at = link.fragment.match(/^L?(\d+)(?:-L?\d+)?$/);
  if (at) line = Number(at[1]);
  else if (link.fragment) {
    line = await fileWsHeadingLine(found.path, link.fragment);
    if (fileWs !== ws) return;
    if (line === null) toast('heading not found · opening ' + link.path);
    else if (line === undefined) toast('could not read the target for its heading · opening ' + link.path);
  }
  return liveFileNavigate(ws, { path: found.path, line: line || 1 });
}
// A linked folder opens as the Files browser at that folder (app.html
// openFolderInApp), which needs the project and root /api/path/info names.
async function fileWsOpenFolder(pathValue, label) {
  let info;
  try { info = await (await fetch('/api/path/info?' + new URLSearchParams({ id: '', path: pathValue }))).json(); }
  catch { info = { error: 'could not check the folder · ' + label }; }
  if (info.error) return errToast(info.error);
  return openFolderInApp(info);
}
// Once per editor host: a notebook parked in the side list comes back with
// the same host, and its links then belong to the workspace showing it now.
const docLinkHosts = new WeakSet();
function fileWsWireDocLinks(ws) {
  const host = $('docEditor');
  if (!host || docLinkHosts.has(host)) return;
  docLinkHosts.add(host);
  // The bundle (0.13.0) reports the click's modifier keys with the event;
  // Ctrl/Cmd means the system application, as on every file control. The
  // 0.12.0 fallback bundle reports none, so a modified click opens in-app.
  host.addEventListener('file-link-navigate', e => {
    const detail = e.detail || {};
    const modifiers = detail.modifiers || {};
    fileWsFollowLink(fileWs || ws, detail.path, { system: !!(modifiers.ctrl || modifiers.meta) });
  });
}

// `park`: the workspace is being left (closeFileWorkspace), so a file the
// side list keeps is parked instead of destroyed. Not when the same visit
// only swaps its editor for History.
function fileWsCloseEditor({ keepDraft = true, park = false } = {}) {
  if (!fileWs) return;
  if (park && fileWs.kind === 'code' && fileWsParkCode(fileWs)) return;
  // A notebook the side list keeps is parked first: it takes the shared
  // text with it, so the leave below lets go of nothing it still uses.
  const parked = fileWs.kind === 'md' && parkDocument();
  fileWsLeaveShared(fileWs);
  fileWs.live?.dispose?.();
  fileWs.imageView?.dispose();
  fileWs.mediaView?.dispose();
  fileWs.htmlPreview?.dispose();
  if (fileWs.editor && fileWs.editor.selection) {
    try { localStorage.setItem('chattering.cursor:' + fileWs.path, String(fileWs.editor.selection().line)); } catch {}
  }
  if (fileWs.kind === 'md') { if (!parked) flushAndCloseDocument(); }
  else if (fileWs.editor) {
    if (keepDraft && fileWs.dirty && !fileWs.wasShared) {
      // Code never autosaves (design §5.3). An unsaved draft survives a
      // navigation in sessionStorage and comes back with a banner.
      try { sessionStorage.setItem('chattering.draft:' + fileWs.path, JSON.stringify({ sha: fileWs.sha, text: fileWs.editor.getContent(), at: Date.now() })); } catch {}
    }
    try { fileWs.editor.destroy(); } catch {}
  }
  fileWs.editor = null;
  if (fileWs.kind !== 'md' && typeof OpenFiles !== 'undefined') OpenFiles.codeReleased(fileWs);
}

function closeFileWorkspace() {
  if (!fileWs) return;
  if (typeof askBubbleClose === 'function') askBubbleClose({ refocus: false });
  fileWsCloseEditor({ park: true });
  clearInterval(fileWs.runTick);
  fileWs = null;
}
// ---- a code or text file kept open (open-files.js, design/77) ----
// Leaving it parks its editor: the element leaves the page but the editor
// stays, with its undo history, cursor, unsaved text and (for a shared
// file) its place in the shared text. What belongs to the visit goes: the
// gutter's annotation worker, an HTML preview, the people listener (it
// paints whatever status line is on screen). Coming back puts the same
// editor into a new frame (fileWsResumeCode).
function fileWsParkCode(ws) {
  if (typeof OpenFiles === 'undefined' || !OpenFiles.keepsCode(ws)) return false;
  const host = $('ffCompare')?.querySelector('.code-host');
  if (!host || !ws.editor.view || !host.contains(ws.editor.view.dom)) return false;
  const scroll = ws.editor.view.scrollDOM?.scrollTop || 0;
  try { localStorage.setItem('chattering.cursor:' + ws.path, String(ws.editor.selection().line)); } catch {}
  ws.live?.dispose?.();
  ws.live = null;
  ws.htmlPreview?.dispose();
  ws.htmlPreview = null;
  if (ws.collabUnsub) { try { ws.collabUnsub(); } catch {} ws.collabUnsub = null; }
  host.hidden = false; // an HTML preview hid the source
  host.remove();
  return OpenFiles.parkCode(ws, { host, scroll });
}
// A parked editor let go for good (its row closed, or the budget of warm
// editors): unsaved single-player text becomes the draft a later visit
// offers back, as when any file is left.
function fileWsDisposeParked(ws) {
  if (!ws || !ws.editor || (typeof fileWs !== 'undefined' && fileWs === ws)) return;
  if (ws.dirty && !ws.wasShared) {
    try { sessionStorage.setItem('chattering.draft:' + ws.path, JSON.stringify({ sha: ws.sha, text: ws.editor.getContent(), at: Date.now() })); } catch {}
  }
  try { ws.editor.destroy(); } catch {}
  ws.editor = null;
  fileWsLeaveShared(ws);
}
// Put a parked editor back, in a new frame, for this visit (openLiveFile
// reuses the parked workspace itself, so every callback bound to it is
// right again). The file may have changed on disk meanwhile: a clean
// single-player editor takes the new text, one with edits is told.
async function fileWsResumeCode(ws, parked, opts = {}) {
  const frame = $('ffCompare');
  if (!frame || fileWs !== ws) return;
  frame.innerHTML = `<div class="doc-view code-view">${liveFileHead(ws)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-editor-host code-host"></div></div>`;
  frame.querySelector('.code-host').replaceWith(parked.host);
  $('liveBack').onclick = () => liveFileGoBack(ws);
  try { ws.editor.setTheme(mrmdHostTheme()); } catch {}
  try { ws.editor.setLineWrapping?.(fileViewPrefs().wrap); } catch {}
  ws.editor.view?.requestMeasure?.();
  fileWsWireCode(ws);
  const preview = ws.htmlPreviewOpen ? '1' : opts.preview;
  ws.htmlPreviewOpen = false;
  fileWsAfterMount(ws, { ...opts, resumed: true, preview });
  // A detached element forgets its scroll offset; a line asked for wins.
  if (parked.scroll && !opts.line) requestAnimationFrame(() => { if (fileWs === ws && ws.editor?.view) ws.editor.view.scrollDOM.scrollTop = parked.scroll; });
  if (!ws.collab && !ws.readOnly) fileWsCheckDiskAfterPark(ws);
}
async function fileWsCheckDiskAfterPark(ws) {
  const asked = ws.editor.getContent();
  let d;
  try { d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path }))).json(); } catch { return; }
  if (fileWs !== ws || !ws.editor || d.error || d.sha === ws.sha) return;
  const clean = asked === ws.baseText && ws.editor.getContent() === asked;
  if (!clean) return fileWsBanner(ws, 'The file changed on disk while it was kept open here. Your unsaved edits are still in the editor.', [['Reload disk', () => liveFileReload(ws)]]);
  fileWsShowText(ws.editor, d.text);
  ws.baseText = d.text; ws.sha = d.sha; ws.dirty = false;
  if ($('fwSave')) $('fwSave').disabled = true;
  liveFileSaved(ws, d.text, d.sha);
  const el = $('docStatus'); if (el) el.textContent = 'Updated: it changed on disk while you were away';
}

// The shared copy of a file (collab-client.js). When the server answers,
// the editor edits the shared text: everyone's cursors show, an agent's
// write merges in, and the disk follows as people type. When it does not
// (old server, no WebSockets), the single-player lock-and-save path runs.
async function fileWsJoinShared(ws) {
  if (typeof collabJoin !== 'function' || !window.chatteringMe || ws.reviewRef) return null;
  try { const s = await collabJoin('file:' + ws.path); if (fileWs !== ws) { collabLeave(s); return null; } ws.collab = s; return s; }
  catch { return null; }
}
function fileWsLeaveShared(ws) {
  if (!ws || !ws.collab) return;
  if (ws.collabUnsub) { try { ws.collabUnsub(); } catch {} ws.collabUnsub = null; }
  collabLeave(ws.collab);
  ws.collab = null;
}
function fileWsSharedStatus(ws, note = '') {
  const el = $('docStatus');
  if (!el || !ws.collab) return;
  const others = ws.collab.people;
  el.innerHTML = (note || 'Shared · saves as you type') + (others.length ? ' · ' + collabPeopleHtml(others, { verb: 'is here' }) : '');
  el.title = 'Everyone who opens this file edits the same text. It lands on disk moments after typing stops; Save (' + modKey('S') + ') writes it right now.';
}
// Save on a shared file: the disk follows by itself, but a person who
// presses Ctrl+S means "now". Same text, same save path, no version check
// (the shared text is the version).
// One explicit save of a shared file at a time: a save asked for while one
// is in flight runs after it (awaitable), instead of being dropped.
function fileWsSharedSave(ws) {
  if (!ws || !ws.collab || !ws.editor) return Promise.resolve();
  ws.sharedSaveQueue = (ws.sharedSaveQueue || Promise.resolve()).then(() => fileWsSharedSaveNow(ws)).catch(e => console.error('shared save', e));
  return ws.sharedSaveQueue;
}

async function fileWsSharedSaveNow(ws) {
  if (!ws.collab || !ws.editor) return;
  ws.sharedSaving = true;
  fileWsSharedStatus(ws, 'Saving…');
  const text = ws.editor.getContent();
  const md = ws.kind === 'md';
  let out;
  try { out = await postJson(md ? '/api/doc/save' : '/api/file/save', { path: ws.path, text, actor: 'human', input: 'keyboard', fromCollab: true, project: ws.project || '' }); }
  catch { out = { error: 'network failure' }; }
  ws.sharedSaving = false;
  if (fileWs !== ws) return;
  if (out.error) { fileWsSharedStatus(ws, '⚠ ' + out.error); return; }
  if (md && docState && docState.path === ws.path) { docState.sha = out.sha; docState.baseText = text; docState.dirty = false; }
  ws.sha = out.sha; ws.baseText = text;
  fileWsSharedStatus(ws, 'Saved · shared');
}

async function fileWsMountBody(ws, opts) {
  if (fileWs !== ws) return;
  if (ws.kind === 'image') await liveFileMountImage(ws);
  else if (ws.kind === 'video') await liveFileMountVideo(ws);
  else if (ws.kind === 'pdf') await liveFileMountPDF(ws);
  else if (ws.kind === 'md') await fileWsMountMarkdown(ws, opts);
  else await fileWsMountCode(ws, opts);
}

async function fileWsMountMarkdown(ws, opts) {
  const host = $('ffCompare');
  if (!host) return;
  host.innerHTML = `<div class="doc-view">${liveFileHead(ws)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-body"><div class="doc-editor-host"><div id="docEditor"></div></div></div></div>`;
  $('liveBack').onclick = () => liveFileGoBack(ws);
  // A notebook kept in the side list comes back as it was left: the same
  // editor, a cell still running where it runs (design/68).
  const parked = typeof OpenFiles !== 'undefined' ? OpenFiles.take(ws.path) : null;
  const resumed = !!parked && resumeDocumentEditor(parked.st, ws, parked.scroll);
  if (!resumed) await mountDocumentEditor(ws.path, ws.project, { focused: true });
  if (fileWs !== ws) return;
  // Markdown the project cannot edit still opens, read-only, as text.
  if (!docState || docState.path !== ws.path) { ws.kind = 'code'; return fileWsMountCode(ws, opts); }
  ws.editor = docState.editor;
  ws.sha = docState.sha;
  fileWsWireDocLinks(ws);
  fileWsAfterMount(ws, resumed ? { ...opts, resumed: true } : opts);
}

// The whole-file editor's AI commands (app.html fileAiOptions). A shared
// file follows the text on its own; one that is not saves only on Save.
function fileWsAiOptions(ws) {
  if (typeof fileAiOptions !== 'function' || typeof ChatteringAiCommands === 'undefined') return undefined;
  const surface = ChatteringAiCommands.surfaceOf(ws.path);
  const options = fileAiOptions(ws, {
    path: ws.path, surface,
    alive: () => fileWs === ws && !!ws.editor,
    get savesItself() { return !!ws.collab; },
    savePending: () => fileWsSharedSave(ws),
    unsaved: () => !!ws.dirty,
  });
  return options && { ...options, scope: surface === 'text' ? 'prose' : 'code', language: liveLanguage(ws.path) };
}

// ---- write mode: code (CodeMirror from the same vendored bundle) ----
// The header stays whatever happens to the file, so Back always works.
function fileWsOpenFailed(ws, label, detail = '') {
  const host = $('view').querySelector('.doc-editor-host');
  if (!host) return;
  host.innerHTML = `<div class="empty">${esc(label)}${detail ? `<div class="hint">${esc(detail)}</div>` : ''}</div>`;
  if ($('liveBack')) $('liveBack').onclick = () => liveFileGoBack(ws);
  if ($('docStatus')) $('docStatus').textContent = '';
  for (const id of ['fwSave', 'docSave', 'liveHistory', 'liveAsk', 'liveHistoryMenu', 'liveAskMenu', 'docRun']) if ($(id)) $(id).hidden = true;
}
// A file the project cannot edit (outside every checkout: a log in /tmp, a
// file under home) still opens, read-only, through the transcript path
// reader. One surface for reading and editing; the state says which.
async function fileWsReadText(ws) {
  const editable = await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path, reviewId: ws.reviewRef?.id || '' })).then(r => r.json());
  if (!editable.error) return editable;
  const conv = typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
  const readOnly = await fetch('/api/path/read?' + new URLSearchParams({ id: conv || '', path: ws.path })).then(r => r.json()).catch(() => null);
  if (readOnly && !readOnly.error) return { ...readOnly, readOnly: true, why: editable.error };
  return editable;
}

async function fileWsMountCode(ws, opts) {
  const host = $('ffCompare');
  if (!host) return;
  host.innerHTML = `<div class="doc-view code-view">${liveFileHead(ws)}<div class="fw-banner" id="fwBanner" hidden></div><div class="doc-editor-host code-host"><div id="codeEditor"></div></div></div>`;
  $('liveBack').onclick = () => liveFileGoBack(ws);
  let bundle, d;
  try { [bundle, d] = await Promise.all([loadMrmdDocument(), fileWsReadText(ws)]); }
  catch (e) { return fileWsOpenFailed(ws, 'Could not open the file.', e.message); }
  if (fileWs !== ws || !$('codeEditor')) return;
  if (d.error) return fileWsOpenFailed(ws, 'Could not read the file.', d.error);
  if (d.text.includes('\0')) return fileWsOpenFailed(ws, 'This is a binary file.', 'Use the system application; this editor only shows text.');
  if (!bundle.createCodeEditor) return fileWsOpenFailed(ws, 'The editor bundle is too old for code files.', 'Reload the app once; the new bundle is served now.');
  ws.sha = d.sha;
  ws.dirty = false;
  let text = d.text;
  let draft = null;
  const shared = d.readOnly || d.canAct === false ? null : await fileWsJoinShared(ws);
  if (fileWs !== ws || !$('codeEditor')) return;
  if (shared) { text = shared.ytext.toString(); ws.wasShared = true; }
  else try { draft = JSON.parse(sessionStorage.getItem('chattering.draft:' + ws.path) || 'null'); } catch {}
  if (draft && draft.text !== d.text) text = draft.text;
  else draft = null;
  const status = t => { const el = $('docStatus'); if (el) el.textContent = t; };
  const markDirty = () => {
    if (fileWs !== ws) return;
    if (ws.collab) return fileWsSharedStatus(ws);
    ws.dirty = ws.editor.getContent() !== ws.baseText;
    $('fwSave').disabled = !ws.dirty;
    status(ws.dirty ? 'Unsaved' : 'Saved');
  };
  ws.baseText = d.text;
  ws.readOnly = !!d.readOnly;
  ws.readOnlyWhy = d.readOnly ? d.why : null;
  ws.editor = bundle.createCodeEditor($('codeEditor'), {
    doc: text, filename: ws.path, theme: mrmdHostTheme(),
    lineWrapping: fileViewPrefs().wrap, // the device's choice (live-file.js)
    extensions: shared ? collabEditorExtension(shared) : [],
    onChange: change => {
      // A person's own edit keeps the file open in the side list (design/77).
      if (change?.userEdit && !ws.readOnly && typeof OpenFiles !== 'undefined') OpenFiles.edited(ws.path, ws.project || '');
      markDirty();
    },
    onSave: () => shared ? fileWsSharedSave(ws) : fileWsSaveCode(ws),
    onLineHover: line => liveFileHover(ws, line),
    onNavigateLocation: location => liveFileNavigate(ws, location),
    onLineHoverEnd: () => { if (ws.live) { ws.live.hover++; ws.live.hoverController?.abort(); } },
    // AI commands (Ctrl+J) for a source or plain-text file: its surface
    // decides the commands and how a block is found; a read-only file has
    // none (the editor refuses).
    ai: fileWsAiOptions(ws),
    // Changes proposed in the text (an ask in review mode): each decision
    // is kept. Code never autosaves: a rejected change is on disk until Save.
    review: {
      onResolved: outcome => {
        aiReviewHost(ws.path).onResolved(outcome);
        if (fileWs === ws && ws.dirty && outcome.decision !== 'accepted') toast('your review changed the text: Save (' + modKey('S') + ') writes it to disk');
      },
    },
  });
  // A restored draft is unsaved text: the controls say so.
  if (draft && !ws.readOnly) ws.dirty = true;
  fileWsWireCode(ws);
  if (ws.readOnly) { fileWsAfterMount(ws, opts); return; }
  if (draft) {
    fileWsBanner(ws, `an unsaved draft from ${ago(Date.now() - draft.at)} ago was restored — save it, or reload from disk to drop it`, [['reload from disk', () => fileWsReloadCode(ws, { dropDraft: true })]]);
    if (draft.sha !== d.sha) {
      ws.sha = draft.sha;
      fileWsBanner(ws, 'This draft was made on an older disk version. Your text is preserved; saving will not silently replace the newer disk file.', [['Reload disk', () => liveFileReload(ws)]]);
    }
  }
  fileWsAfterMount(ws, opts);
}

// The frame's controls for the editor in it: at mount, and again when a
// parked editor comes back into a new frame.
function fileWsWireCode(ws) {
  const status = t => { const el = $('docStatus'); if (el) el.textContent = t; };
  $('docReload').onclick = () => fileWsReloadCode(ws);
  if (ws.readOnly) {
    try { ws.editor.setReadonly(true); } catch {}
    $('fwSave').hidden = true;
    for (const id of ['liveAsk', 'liveAskMenu', 'liveAi']) if ($(id)) $(id).hidden = true;
    status('Read-only · ' + (ws.readOnlyWhy || ''));
    return;
  }
  if (ws.collab) {
    $('fwSave').disabled = false;
    $('fwSave').title = 'Shared: the disk follows as you type. Save writes it right now · Ctrl+S';
    $('fwSave').onclick = () => fileWsSharedSave(ws);
    ws.collabUnsub = collabOnPeople(ws.collab, () => fileWsSharedStatus(ws));
    fileWsSharedStatus(ws);
    return;
  }
  $('fwSave').onclick = () => fileWsSaveCode(ws);
  $('fwSave').disabled = !ws.dirty;
  status(ws.dirty ? 'Unsaved' : 'Saved');
}

async function fileWsSaveCode(ws) {
  if (fileWs !== ws || !ws.editor || ws.saving) return;
  const text = ws.editor.getContent();
  if (text === ws.baseText) return;
  ws.saving = true;
  $('fwSave').disabled = true;
  let out;
  try { out = await postJson('/api/file/save', { path: ws.path, baseSha: ws.sha, text, reviewId: ws.reviewRef?.id }); }
  catch { out = { error: 'Network failure; your edits are still in the editor' }; }
  ws.saving = false;
  if (fileWs !== ws) return;
  if (out.error) {
    $('fwSave').disabled = false;
    if (String(out.error).includes('changed on disk')) {
      fileWsBanner(ws, 'The disk file changed. Your edits are kept here and were not overwritten.', [['Copy my edits', () => copyText(ws.editor.getContent()).catch(e => errToast(e.message))], ['Reload disk', () => liveFileReload(ws)]]);
    }
    return errToast('save failed: ' + out.error);
  }
  ws.sha = out.sha;
  ws.baseText = text;
  // Typing may continue while the save is in flight. Only the submitted
  // revision was saved; retain the newer text as an unsaved draft.
  ws.dirty = ws.editor.getContent() !== text;
  $('fwSave').disabled = !ws.dirty;
  if (!ws.dirty) try { sessionStorage.removeItem('chattering.draft:' + ws.path); } catch {}
  const el = $('docStatus'); if (el) el.textContent = ws.dirty ? 'Unsaved' : 'Saved';
  fileWsBanner(ws, out.historyWarning ? 'Saved, but history capture failed: ' + out.historyWarning : null);
  liveFileSaved(ws, text, out.sha);
}

async function fileWsReloadCode(ws, { dropDraft = false } = {}) {
  if (fileWs !== ws || !ws.editor) return;
  const requestedText = ws.editor.getContent();
  let d;
  try { d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path, reviewId: ws.reviewRef?.id || '' }))).json(); } catch { d = { error: 'network failure' }; }
  if (fileWs !== ws || !ws.editor) return;
  if (d.error) return errToast(d.error);
  if (ws.editor.getContent() !== requestedText) return fileWsBanner(ws, 'Kept the edits you typed while reloading. Reload again when ready.', [['Reload disk', () => liveFileReload(ws)]]);
  const sel = ws.editor.selection();
  ws.editor.setContent(d.text);
  ws.baseText = d.text; ws.sha = d.sha; ws.dirty = false;
  if (dropDraft) try { sessionStorage.removeItem('chattering.draft:' + ws.path); } catch {}
  $('fwSave').disabled = true;
  $('docReload').hidden = true;
  try { ws.editor.gotoLine(sel.line); } catch {}
  fileWsBanner(ws, null);
  liveFileSaved(ws, d.text, d.sha);
  $('docStatus').textContent = 'Reloaded';
}

// After a reload: mark the lines that changed (code gutter) and say how much.

function fileWsBanner(ws, text, actions = []) {
  const el = $('fwBanner');
  if (!el) return;
  if (!text) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span>${esc(text)}</span>${actions.map((a, i) => `<button type="button" data-fw-act="${i}">${esc(a[0])}</button>`).join('')}<button type="button" class="ghost" data-fw-dismiss title="dismiss">✕</button>`;
  el.querySelectorAll('[data-fw-act]').forEach(b => b.onclick = () => actions[Number(b.dataset.fwAct)][1]());
  el.querySelector('[data-fw-dismiss]').onclick = () => fileWsBanner(ws, null);
}

// Common tail of a mount: cursor memory, the requested line, shortcuts.

// Where a mount puts the cursor. The route's line is where a link, a shared
// URL or a reload sends the reader. A return (back, forward: opts.restore)
// lands on the cursor left behind instead, the way a browser returns to a
// page's scroll rather than to the anchor it was first opened at; the
// route's line still applies when nothing was left behind.
function fileWsMountLine(ws, opts) {
  const asked = opts.line || ws.line || null;
  let remembered = null;
  try { const saved = Number(localStorage.getItem('chattering.cursor:' + ws.path)); if (saved > 1) remembered = saved; } catch {}
  return opts.restore ? remembered || asked : asked || remembered;
}

function fileWsAfterMount(ws, opts) {
  if (fileWs !== ws || !ws.editor) return;
  if (typeof renderPresenceMarks === 'function') renderPresenceMarks();
  // A notebook back from the side list keeps its place unless a line was asked for.
  const line = opts.resumed && !opts.line && !ws.line ? null : fileWsMountLine(ws, opts);
  if (line && ws.editor.gotoLine) { try { ws.editor.gotoLine(line); } catch {} }
  ws.line = null;
  liveFileAfterMount(ws);
  if (/\.html?$/i.test(ws.path)) liveFileEnableHTML(ws, opts);
}

// ---- an agent working on this file (asked from the ask box, ask-bubble.js) ----
// The run a workspace started: the editor is read-only until it settles, so
// nothing typed races the agent's edits; then the file reloads and the
// agent's lines are marked — or, in review mode, shown as changes to
// accept or reject (the editor's review captures everything the run
// changes in the text).

// out: the /api/files/ask reply. ask: what the box sent ({prompt, mode,
// model, thinking, include, selection}), kept with the outcome.
function fileWsBeginRun(ws, out, ask = {}) {
  ws.run = { jobId: out.job ? out.job.id : null, key: out.key, startedAt: Date.now(), preSha: ws.sha, preText: ws.editor ? ws.editor.getContent() : null, title: out.title || (out.created ? 'new conversation' : 'conversation'), created: out.created, queued: out.queued };
  ws.run.ask = { ...ask, jobId: ws.run.jobId, key: out.key, created: !!out.created };
  ws.run.editor = ws.editor;
  // A queued ask shares the running turn: its changes are that turn's.
  if (ask.mode === 'review' && !out.queued && ws.editor && ws.editor.review) {
    const label = 'Ask: \u201c' + (ask.prompt.length > 40 ? ask.prompt.slice(0, 39) + '\u2026' : ask.prompt) + '\u201d';
    try { ws.run.capture = ws.editor.review.capture({ source: 'ask', label, ...ws.run.ask }); }
    catch (e) { ws.run.ask.mode = 'apply'; toast('the changes will not be reviewed: ' + e.message); }
  } else if (ask.mode === 'review') ws.run.ask.mode = 'apply';
  fileWsLockEditor(ws, true);
  fileWsPaintRun(ws, { statusText: out.queued ? 'queued behind the running turn' : 'starting' });
  clearInterval(ws.runTick);
  ws.runTick = setInterval(() => { if (fileWs === ws && ws.run) fileWsPaintRun(ws, ws.runLast || {}); else clearInterval(ws.runTick); }, 1000);
}

function fileWsLockEditor(ws, lock) {
  if (!ws.editor) return;
  try { ws.editor.setReadonly(lock); } catch {}
  if (lock) fileWsBanner(ws, 'an agent is changing this file — typing is paused until it finishes, so its changes and yours do not collide', [['details', () => open(ws.run.key, 'bottom')], ['stop', () => fileWsAbortRun(ws)]]);
  else fileWsBanner(ws, null);
}

function fileWsPaintRun(ws, d) {
  if (!ws.run) return;
  ws.runLast = d;
  if (typeof askBubblePaintRun === 'function') askBubblePaintRun(ws, d);
}

async function fileWsAbortRun(ws) {
  if (!ws.run || !ws.run.jobId) return;
  await postJson('/api/run/abort', { jobId: ws.run.jobId });
}

// SSE run-event for the run this workspace started.

function fileWsRunEvent(d) {
  const ws = fileWs;
  if (!ws || !ws.run) return;
  if (d.jobId !== ws.run.jobId && d.key !== ws.run.key) return;
  if (!ws.run.jobId && d.jobId) ws.run.jobId = d.jobId;
  if (!d.final) { fileWsPaintRun(ws, d); return; }
  clearInterval(ws.runTick);
  const status = d.status === 'done' ? '✓ settled' : '✗ ' + (d.statusText || d.status || 'ended');
  const failed = d.status !== 'done';
  const run = ws.run;
  ws.run = null;
  // The agent may have rewritten the file: reload (still read-only, so the
  // review captures only the agent's changes), then give the text back.
  fileWsReloadAfterRun(ws, run).then(result => {
    const here = fileWs === ws && ws.editor === run.editor;
    const reviewing = !!(run.capture && here && run.capture.end());
    if (here) fileWsLockEditor(ws, false);
    // Recorded now unless a review will record it when it is decided.
    if (!reviewing) aiAskSettled(ws.path, run.ask, { changed: result.changed, failed, before: run.preText, after: result.text, status: d.statusText || d.status || null });
    if (!here) return;
    if (typeof askBubbleSettled === 'function') askBubbleSettled(ws, run, { status, ...result, reviewing });
  });
}

// Reload the file after a run by the smallest changes (the cursor, marks
// and a review keep their places). {summary, changed, undoable, text}:
// undoable when the reload was one change in this editor (Ctrl+Z takes it
// back); text, the file as the run left it.
function fileWsShowText(editor, text) {
  if (typeof editor.updateContent === 'function') editor.updateContent(text);
  else editor.setContent(text);
}
async function fileWsReloadAfterRun(ws, run) {
  let d;
  try { d = await (await fetch('/api/file/read?path=' + encodeURIComponent(ws.path))).json(); } catch { return { summary: 'could not re-read the file', changed: false }; }
  if (fileWs !== ws || d.error) return { summary: d && d.error ? d.error : '', changed: false };
  if (d.sha === run.preSha) return { summary: 'the file did not change', changed: false, text: d.text };
  const before = run.preText || '';
  let undoable = false;
  if (ws.kind === 'md' && docState && docState.path === ws.path) {
    if (docState.dirty) return { summary: 'the file changed on disk while you had edits — reload from disk to see them', changed: true };
    // A shared document already carries the agent's write (it merged in).
    if (docState.editor.getContent() !== d.text) { fileWsShowText(docState.editor, d.text); undoable = !ws.collab; }
    docState.sha = d.sha;
    docState.dirty = false;
    if ($('docReload')) $('docReload').hidden = true;
  } else if (ws.kind === 'code' && ws.editor) {
    const sel = ws.editor.selection();
    const minimal = typeof ws.editor.updateContent === 'function';
    if (ws.editor.getContent() !== d.text) { fileWsShowText(ws.editor, d.text); undoable = !ws.collab; }
    ws.baseText = d.text; ws.sha = d.sha; ws.dirty = false;
    if ($('fwSave')) $('fwSave').disabled = true;
    if (!minimal) try { ws.editor.gotoLine(sel.line); } catch {} // a whole replace lost the cursor
  }
  // The gutter keeps the opening text as its baseline, so the agent's
  // lines show as changes; the disk baseline moves to what was just read.
  liveFileSaved(ws, d.text, d.sha);
  const stats = typeof LineDiff !== 'undefined' ? LineDiff.scriptStats(LineDiff.diffLines(before, d.text)) : null;
  return { summary: stats ? `agent changed +${stats.added} −${stats.removed} lines` : 'agent changed the file', changed: true, undoable, text: d.text };
}

// ---- who touched this file ----

let whoStripTimer = null;

function fileWsFileActivity(d) {
  fbActivity(d);
  const ws = fileWs;
  if (!ws || !ws.path || d.path !== ws.path) return;
  if (ws.collab) return; // the shared text already carries the disk change
  if (ws.run) return; // the run's own settle handles the reload
  if (ws.mode === 'write' && ws.editor) liveFileActivity(ws);
}

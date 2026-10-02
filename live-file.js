'use strict';
// A small editing surface. File lifecycle stays with fileWs/docState; history,
// repository trees and agent composers are deliberately not mounted here.
const liveLanguageFactories = new Map();
function liveLanguage(path) {
  const name = String(path).split(/[\\/]/).pop().toLowerCase(), ext = name.split('.').pop();
  return ({ __proto__: null, js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', pyi: 'python', rs: 'rust', go: 'go', md: 'markdown', markdown: 'markdown', mdx: 'markdown', qmd: 'markdown', rmd: 'markdown',
    html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', css: 'css', scss: 'scss', less: 'less', json: 'json', jsonc: 'json', webmanifest: 'json',
    sql: 'sql', r: 'r', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', bashrc: 'shell', zshrc: 'shell', profile: 'shell', yaml: 'yaml', yml: 'yaml',
    c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', java: 'java', xml: 'xml', svg: 'xml', toml: 'toml', lua: 'lua', rb: 'ruby',
    dockerfile: 'dockerfile', containerfile: 'dockerfile', diff: 'diff', patch: 'diff' })[ext] || 'text';
}
// ---- how files look, on this device ----
// Text size (every file editor), long lines wrapping (code and text files;
// Markdown documents always wrap, at a width: a narrow column of about 70
// characters that grows with the text, the app's reading column, or the
// whole window), and the documents' font. Saved in this browser, like the app's
// font and theme: a phone, a desk and the e-ink tablet can differ.
//
// Size and font are CSS custom properties on the root, which the editors'
// theme reads (app.html mrmdHostTheme, .doc-editor-host rules), so every
// open editor follows at once. Wrapping is the editor's own switch.
const FILE_VIEW_KEY = 'chattering.fileView.v1';
const FILE_TEXT_SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
// The documents' font: the choices of the app's font (app.html appFonts),
// with monospace — the look documents have always had — first.
const FILE_DOC_FONTS = {
  mono: { label: 'Monospace', value: 'var(--font-mono)' },
  app: { label: 'The app’s font', value: 'var(--font)' },
  sans: { label: 'System sans', from: 'sans' },
  humanist: { label: 'Humanist sans', from: 'humanist' },
  serif: { label: 'Book serif', from: 'serif' },
};

function fileViewPrefs() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(FILE_VIEW_KEY) || 'null'); } catch {}
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    scale: FILE_TEXT_SCALES.includes(r.scale) ? r.scale : 1,
    wrap: r.wrap !== false,
    width: ['narrow', 'full'].includes(r.width) ? r.width : 'read',
    font: Object.hasOwn(FILE_DOC_FONTS, r.font) ? r.font : 'mono',
  };
}

function fileDocFontValue(id) {
  const f = FILE_DOC_FONTS[id] || FILE_DOC_FONTS.mono;
  return f.value || (window.appFonts && window.appFonts[f.from] && window.appFonts[f.from].value) || 'var(--font-mono)';
}

// The root's custom properties, from the prefs. Applied when this script
// loads: no file view is on screen before it. (Without a page — this file
// run in a test sandbox — there is nothing to style.)
function applyFileViewStyle(prefs = fileViewPrefs()) {
  const root = typeof document !== 'undefined' && document.documentElement ? document.documentElement.style : null;
  if (!root) return;
  root.setProperty('--file-text-scale', String(prefs.scale));
  root.setProperty('--doc-font', fileDocFontValue(prefs.font));
  // Narrow: about 70 characters of a proportional font, scaled with the text.
  if (prefs.width === 'full') root.setProperty('--doc-width', 'none');
  else if (prefs.width === 'narrow') root.setProperty('--doc-width', 'calc(760px * var(--file-text-scale, 1))');
  else root.removeProperty('--doc-width');
}
applyFileViewStyle();

// Change the prefs and show them in the open file at once.
function setFileViewPrefs(patch) {
  const prev = fileViewPrefs();
  const next = { ...prev, ...patch };
  try { localStorage.setItem(FILE_VIEW_KEY, JSON.stringify(next)); } catch {}
  applyFileViewStyle(next);
  const editor = typeof fileWs !== 'undefined' && fileWs ? fileWs.editor : null;
  if (editor) {
    if (next.wrap !== prev.wrap && fileWs.kind === 'code' && typeof editor.setLineWrapping === 'function') editor.setLineWrapping(next.wrap);
    // A fixed-height editor does not notice its lines changing size.
    editor.view?.requestMeasure();
  }
  for (const el of document.querySelectorAll('.fv-controls')) paintFileViewControls(el);
  return next;
}

// One step smaller or larger (dir -1 / +1), or back to 100% (0). `quiet`:
// the controls show the size themselves (a key press has only the toast).
function stepFileTextSize(dir, quiet = false) {
  const { scale } = fileViewPrefs();
  const i = FILE_TEXT_SCALES.indexOf(scale);
  const next = dir === 0 ? 1 : FILE_TEXT_SCALES[Math.max(0, Math.min(FILE_TEXT_SCALES.length - 1, i + dir))];
  if (next === scale) { if (!quiet) toast(dir > 0 ? 'the text is as large as it goes' : dir < 0 ? 'the text is as small as it goes' : 'the text is at 100%'); return; }
  setFileViewPrefs({ scale: next });
  if (!quiet) toast('text ' + Math.round(next * 100) + '%');
}

function toggleFileWrap() {
  const wrap = !fileViewPrefs().wrap;
  setFileViewPrefs({ wrap });
  toast(wrap ? 'long lines wrap' : 'long lines scroll sideways');
}

/**
 * The controls, for the file's ⋯ menu and Settings → appearance. `kind`:
 * 'md' (a document: width and font), 'code' (a code or text file:
 * wrapping), 'all' (settings).
 */
function fileViewControlsHtml(kind = 'all') {
  const docs = kind !== 'code', code = kind !== 'md';
  return `<div class="fv-controls" role="group" aria-label="How files look on this device">
    <div class="fv-row"><span class="fv-label">Text size</span>
      <button type="button" data-fv="smaller" title="Smaller text (Alt+−, in the text)" aria-label="Smaller text">A−</button>
      <output data-fv-size aria-live="polite"></output>
      <button type="button" data-fv="larger" title="Larger text (Alt+=, in the text)" aria-label="Larger text">A+</button>
      <button type="button" data-fv="reset" title="Back to 100% (Alt+0, in the text)">reset</button></div>
    ${code ? '<label class="fv-row"><input type="checkbox" data-fv="wrap"> <span>Wrap long lines' + (kind === 'all' ? ' in code and text files' : '') + '</span> <kbd>Alt+Z</kbd></label>' : ''}
    ${docs ? `<label class="fv-row"><span class="fv-label">${kind === 'all' ? 'Document width' : 'Width'}</span><select data-fv="width"><option value="narrow">narrow column</option><option value="read">reading column</option><option value="full">whole window</option></select></label>` : ''}
    ${docs ? `<label class="fv-row"><span class="fv-label">${kind === 'all' ? 'Document font' : 'Font'}</span><select data-fv="font">${Object.entries(FILE_DOC_FONTS).map(([id, f]) => `<option value="${id}">${esc(f.label)}</option>`).join('')}</select></label>` : ''}
  </div>`;
}

function paintFileViewControls(el) {
  const p = fileViewPrefs();
  const size = el.querySelector('[data-fv-size]');
  if (size) size.textContent = Math.round(p.scale * 100) + '%';
  const q = sel => el.querySelector(sel);
  if (q('[data-fv="smaller"]')) q('[data-fv="smaller"]').disabled = p.scale === FILE_TEXT_SCALES[0];
  if (q('[data-fv="larger"]')) q('[data-fv="larger"]').disabled = p.scale === FILE_TEXT_SCALES[FILE_TEXT_SCALES.length - 1];
  if (q('[data-fv="reset"]')) q('[data-fv="reset"]').hidden = p.scale === 1;
  if (q('[data-fv="wrap"]')) q('[data-fv="wrap"]').checked = p.wrap;
  if (q('[data-fv="width"]')) q('[data-fv="width"]').value = p.width;
  if (q('[data-fv="font"]')) q('[data-fv="font"]').value = p.font;
}

function wireFileViewControls(root) {
  for (const el of root.querySelectorAll('.fv-controls')) {
    paintFileViewControls(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('button[data-fv]');
      if (!b) return;
      stepFileTextSize({ smaller: -1, larger: 1, reset: 0 }[b.dataset.fv], true);
    });
    el.addEventListener('change', e => {
      const f = e.target.dataset.fv;
      if (f === 'wrap') setFileViewPrefs({ wrap: e.target.checked });
      else if (f === 'width' || f === 'font') setFileViewPrefs({ [f]: e.target.value });
    });
  }
}

// The keys, in the text: Alt+= / Alt+− / Alt+0 size, Alt+Z wrapping (code
// and text files). By key position, so layouts and Alt characters do not
// matter. True when the key was one of them.
function fileViewKey(ws, e) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return false;
  const dir = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 }[e.code];
  if (dir !== undefined) { e.preventDefault(); stepFileTextSize(dir); return true; }
  if (e.code === 'KeyZ' && !e.shiftKey && ws.kind === 'code') { e.preventDefault(); toggleFileWrap(); return true; }
  return false;
}

// A future LSP bridge registers a factory returning {name, complete, hover,
// definition, dispose}. Offsets are CodeMirror/JavaScript UTF-16 positions.
// The adapter owns server lifecycle and diagnostics; no server starts implicitly.
function registerLiveFileLanguageService(language, factory) {
  liveLanguageFactories.set(language, factory);
  return () => { if (liveLanguageFactories.get(language) === factory) liveLanguageFactories.delete(language); };
}
function liveFileLabel(ws) {
  const root = ws.touched?.repoRoot;
  if (root && ws.path.startsWith(root + '/')) return ws.path.slice(root.length + 1);
  // No checkout known yet: the path from the project folder is enough.
  const at = ws.project ? ws.path.indexOf('/' + ws.project + '/') : -1;
  if (at >= 0) return ws.path.slice(at + ws.project.length + 2);
  return ws.path.replace(/^\/home\/[^/]+\//, '~/');
}
function liveBackLabel(ws) {
  if (!ws.back) return ws.browserContext || ws.project ? '← Files' : '← Back';
  if (ws.back.startsWith('review=')) return '← Review';
  if (typeof fbConversationHash === 'function' && fbConversationHash(ws.back)) return '← Conversation';
  if (ws.back.startsWith('browse=')) return '← Files';
  if (ws.back.startsWith('filecall=')) return '← Change';
  return '← Back';
}
// One row: where you came from, the file, its state, and the few actions a
// file needs. History and Ask live in the row on a wide screen and under
// ⋯ on a phone, so the row never wraps over the text.
function liveFileHead(ws) {
  const md = ws.kind === 'md';
  return `<header class="live-file-head">
    <button id="liveBack" title="${fgAttr(liveBackLabel(ws).slice(2))}: return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${esc(liveBackLabel(ws).slice(2))}</span></button>
    ${liveFileNameHtml(ws)}
    ${typeof presenceFileSlotHtml === 'function' ? presenceFileSlotHtml(ws.path) : ''}
    <span id="docStatus" role="status">Opening…</span>
    <span id="liveServiceStatus" title="Built-in language support; no language server connected">${esc(liveLanguage(ws.path))}</span>
    ${/\.html?$/i.test(ws.path) ? '<div class="lf-html-switch" role="group" aria-label="HTML view"><button id="htmlSource" aria-pressed="true">Source</button><button id="htmlPreview" aria-pressed="false">Preview</button></div>' : ''}
    <button id="docReload" hidden title="Reload the current disk file">Reload</button>
    <button id="liveHistory" class="lf-wide" title="Recorded versions of this file: read one, or compare two">History</button>
    <button id="liveWithConv" class="lf-wide lf-page-only" title="This file with its conversation beside it: the conversation that opened it or last worked on it">☷ Conversation beside</button>
    <button id="liveAsk" class="lf-wide" title="Ask an agent for a change here: a box opens over the text · ${modKey('K')}">✦ Ask</button>
    ${md ? '<button id="docRun" class="lf-wide" title="Run the cell at the cursor · Ctrl+Enter">▶ Run</button>' : ''}
    ${md && liveFileCanShare() ? '<button id="liveShare" class="lf-wide" title="A link for people to read or edit this document live, from this computer">Share</button>' : ''}
    <button id="${md ? 'docSave' : 'fwSave'}" ${md ? '' : 'disabled'} title="Save to disk · Ctrl+S">Save</button>
    <details class="live-more"><summary aria-label="Editor options">⋯</summary><div>
      <button id="liveHistoryMenu" class="lf-narrow">History</button>
      <button id="liveAskMenu" class="lf-narrow">✦ Ask for a change (${modKey('K')})</button>
      <button id="liveWithConvMenu" class="lf-narrow lf-page-only">☷ Its conversation beside</button>
      ${md ? '<button id="docRunMenu" class="lf-narrow">▶ Run this cell</button>' : ''}
      ${md && liveFileCanShare() ? '<button id="liveShareMenu" class="lf-narrow">Share by link…</button>' : ''}
      ${typeof OpenFiles !== 'undefined' ? `<button data-keep-menu="${fgAttr(ws.path)}">${esc(OpenFiles.menuLabel(ws.path))}</button>` : ''}
      ${ws.project ? '<button id="liveBrowse">Browse this folder</button>' : ''}
      <button id="liveAi">✦ AI commands (${modKey('J')})</button>
      ${md ? '<button id="docRunAll">Run all cells</button><button id="docVars">Variables</button><button id="docKernel">Kernel: restart, clear, shut down…</button><button id="docSource">Markdown source</button><button id="docUnwrap" hidden>Unwrap prose</button>' : ''}
      <span id="liveAnnotationStatus">Gutter: changes and line attribution</span>
      ${fileViewControlsHtml(md ? 'md' : 'code')}
      <button id="liveKeys">Keyboard shortcuts (Ctrl+?)</button>
    </div></details>
  </header>`;
}
// Sharing by link (design/92, shares-ui.js) is the household's, not a guest's.
function liveFileCanShare() { return typeof SharesUI !== 'undefined' && !(window.chatteringMe && window.chatteringMe.scope === 'guest'); }
// The file's name, and the pin that keeps it open in the side list
// (open-files.js, design/77). By the name, not among the actions: it is
// about the file, and on a phone it stays when the actions fold under ⋯.
// The name shortens (…) before the pin moves away from it.
function liveFileNameHtml(ws) {
  const keep = typeof OpenFiles !== 'undefined' ? OpenFiles.keepButtonHtml(ws.path, ws.project || '', { id: 'fileKeep' }) : '';
  return `<span class="lf-name"><b id="ffTitle" title="${fgAttr(ws.path)}">${esc(liveFileLabel(ws))}</b>${keep}</span>`;
}
// The file view's frame: one element that holds the head, banners and the
// editor. It lives in the page (#view) or beside a conversation (the
// artifact panel, design/83), and moves between them as it is.
function liveFileFrame() {
  const frame = document.createElement('section');
  frame.className = 'files-ws live-file-view';
  frame.innerHTML = '<div id="ffCompare" class="live-file-body"></div>';
  return frame;
}
// Where the frame is now: controls that only make sense on the page (← back,
// "with its conversation") hide beside a conversation, and the other way.
function liveFilePlaced(ws) {
  if (!ws || !ws.frame) return;
  const beside = ws.placement === 'beside';
  ws.frame.classList.toggle('beside', beside);
  ws.editor?.view?.requestMeasure?.();
  if (typeof askBubblePlace === 'function') askBubblePlace();
}
// Beside → the page: the same editor, full page, with ← back to its conversation.
function fileWsToPage(ws) {
  if (!ws || fileWs !== ws || !ws.frame) return;
  const key = ws.besideKey;
  ws.frame.remove();
  ws.placement = 'page';
  ws.besideKey = null;
  if (key) ws.back = key;
  if (key && typeof Artifacts !== 'undefined') { try { localStorage.removeItem('chattering.artifact.v1:' + key); } catch {} }
  setRoute('file', fileWsHash(ws), { project: ws.project || (typeof scopeFileProject === 'function' ? scopeFileProject(ws) : undefined) });
  $('view').replaceChildren(ws.frame);
  if ($('liveBack')) { $('liveBack').onclick = () => liveFileGoBack(ws); const label = $('liveBack').querySelector('.lf-wide'); if (label) label.textContent = liveBackLabel(ws).slice(2); }
  liveFilePlaced(ws);
  try { ws.editor?.focus?.(); } catch {}
}

async function openLiveFile(pathValue, opts = {}) {
  // Beside a conversation (design/83): the panel is the host, the route stays
  // the conversation's.
  if (opts.beside) return openLiveFileBeside(pathValue, opts);
  // The file beside the conversation, asked for full page: it moves.
  if (fileWs && fileWs.placement === 'beside' && fileWs.path === String(pathValue) && fileWs.frame && !opts.reviewRef && !opts.to && !opts.from) {
    fileWsToPage(fileWs);
    if (opts.line && fileWs.editor?.gotoLine) { try { fileWs.editor.gotoLine(opts.line); } catch {} }
    return;
  }
  const seq = ++fileWsSeq;
  // A conversation fetch/render that began before this navigation must not
  // paint over the file when it eventually finishes.
  if (typeof conversationLoadSeq !== 'undefined') conversationLoadSeq++;
  markSettingsClosed();
  if (window.fileInk?.teardown) fileInk.teardown();
  if (progressStream) { progressStream.close(); progressStream = null; }
  closeFileWorkspace();
  // A code or text file kept open in the side list comes back as it was
  // left (open-files.js): the same workspace and editor, for this visit.
  // Not for a review or history visit, which read the file another way.
  const parked = !opts.reviewRef && !opts.to && !opts.from && typeof OpenFiles !== 'undefined' ? OpenFiles.takeCode(String(pathValue)) : null;
  const visit = { focused: true, mode: 'write', seq, line: opts.line || null, back: opts.back || null,
    touched: { repoRoot: opts.root || '', sessions: [], commits: [] }, browserContext: opts.browserContext || null, row: null, recentOpened: false };
  const ws = parked
    ? Object.assign(parked.ws, visit, { project: opts.project || parked.ws.project || null, touched: { ...visit.touched, repoRoot: opts.root || parked.ws.touched?.repoRoot || '' } })
    : { path: String(pathValue), project: opts.project || null, kind: fileWsKind(pathValue), editor: null, sha: null, dirty: false, saving: false,
      ...visit, reviewRef: opts.reviewRef || null, reviewData: opts.reviewData || null };
  ws.placement = 'page';
  ws.besideKey = null;
  fileWs = ws;
  setRoute('file', fileWsHash(ws), { project: ws.project || (typeof scopeFileProject === 'function' ? scopeFileProject(ws) : undefined) });
  $('view').replaceChildren(ws.frame = liveFileFrame());
  if (parked) return fileWsResumeCode(ws, parked, opts);
  // A link may name recorded versions (to=, from=): open straight into history.
  if (opts.to || opts.from) return liveFileHistory(ws, { to: opts.to || null, from: opts.from || null });
  await fileWsMountBody(ws, opts);
}
// The file in the artifact panel beside a conversation: the same workspace
// and editor as full page, without a route of its own. One file workspace at
// a time, as always: the one shown before is closed (or parked, if kept).
async function openLiveFileBeside(pathValue, opts) {
  const { host, key } = opts.beside;
  const seq = ++fileWsSeq;
  closeFileWorkspace();
  const parked = typeof OpenFiles !== 'undefined' ? OpenFiles.takeCode(String(pathValue)) : null;
  const visit = { focused: true, mode: 'write', seq, line: opts.line || null, back: key,
    touched: { repoRoot: '', sessions: [], commits: [] }, browserContext: null, row: null, recentOpened: false, placement: 'beside', besideKey: key };
  const ws = parked
    ? Object.assign(parked.ws, visit, { project: opts.project || parked.ws.project || null })
    : { path: String(pathValue), project: opts.project || null, kind: fileWsKind(pathValue), editor: null, sha: null, dirty: false, saving: false, ...visit, reviewRef: null, reviewData: null };
  fileWs = ws;
  host.replaceChildren(ws.frame = liveFileFrame());
  liveFilePlaced(ws);
  if (parked) return fileWsResumeCode(ws, parked, opts);
  await fileWsMountBody(ws, opts);
  if (fileWs === ws) liveFilePlaced(ws);
}

// Images share file navigation, but never mount an editor, drafts or save actions.
// Fetch as a blob so access errors remain readable and reload bypasses the cache.
async function liveFileMountImage(ws) {
  const host = $('ffCompare');
  if (fileWs !== ws || !host) return;
  ws.imageView?.dispose();
  ws.readOnly = true;
  host.innerHTML = `<div class="doc-view image-view">
    <header class="live-file-head lf-media-head">
      <button id="liveBack" title="Return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${esc(liveBackLabel(ws).slice(2))}</span></button>
      ${liveFileNameHtml(ws)}
      <span id="docStatus" role="status">Opening image…</span>
      <button id="imageFit" aria-pressed="true" title="Fit the image in the panel">Fit</button>
      <button id="imageActual" aria-pressed="false" title="One image pixel per screen CSS pixel; scroll to explore">Actual size</button>
      <button id="imageReload" title="Reload the image from disk">Reload</button>
      <a href="${fgAttr(fileViewerURL(ws, true))}" download>Download</a>
    </header>
    <div id="imageStage" class="lf-image-stage" tabindex="0" aria-label="Image preview; scroll in actual size mode">
      <img id="fileImage" alt="${fgAttr(ws.path.split(/[\\/]/).pop())}" hidden>
      <p id="imageMessage" role="status">Opening image…</p>
    </div>
  </div>`;
  const image = $('fileImage'), stage = $('imageStage'), message = $('imageMessage'), status = $('docStatus');
  const fit = $('imageFit'), actual = $('imageActual');
  const controller = new AbortController();
  const state = ws.imageView = { disposed: false, url: null, dispose() {
    state.disposed = true; controller.abort();
    image.onload = image.onerror = null; image.removeAttribute('src');
    if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
  } };
  const current = () => fileWs === ws && ws.imageView === state && !state.disposed;
  const sizing = full => {
    stage.classList.toggle('lf-image-actual', full);
    image.style.width = full ? image.naturalWidth + 'px' : '';
    image.style.height = full ? image.naturalHeight + 'px' : '';
    fit.setAttribute('aria-pressed', String(!full)); actual.setAttribute('aria-pressed', String(full));
    stage.scrollTop = stage.scrollLeft = 0;
  };
  fit.disabled = actual.disabled = true;
  fit.onclick = () => sizing(false); actual.onclick = () => sizing(true);
  $('liveBack').onclick = () => liveFileGoBack(ws);
  $('imageReload').onclick = () => liveFileMountImage(ws);
  const fail = detail => {
    if (!current()) return;
    image.hidden = true; message.hidden = false;
    status.textContent = 'Image unavailable';
    message.textContent = detail;
    fit.disabled = actual.disabled = true;
  };
  image.onload = () => {
    if (!current()) return;
    image.hidden = false; message.hidden = true;
    status.textContent = `${image.naturalWidth} × ${image.naturalHeight} · Read-only`;
    fit.disabled = actual.disabled = false;
    liveFileRememberOpen(ws);
  };
  image.onerror = () => fail('The browser could not display this image. It may be damaged or use an unsupported format.');
  try {
    const conv = typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
    const response = await fetch('/api/path/content?' + new URLSearchParams({ id: conv || '', path: ws.path }), { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `Could not load the image (${response.status}).`);
    }
    const blob = await response.blob();
    if (!current()) return;
    state.url = URL.createObjectURL(blob);
    image.src = state.url;
  } catch (error) { if (current()) fail(error.message || 'Could not load the image. Try Reload.'); }
}
function liveFileGoBack(ws) {
  if (ws.back) return typeof fbReturnTo === 'function' ? fbReturnTo(ws.back) : dispatchHash(ws.back);
  if (ws.browserContext) return showFilesBrowser(ws.project, ws.browserContext);
  return ws.project ? showFilesBrowser(ws.project) : goHome();
}
function liveFileBrowseFolder(ws) {
  const context = ws.browserContext || { conv: (typeof fbConversationHash === 'function' && fbConversationHash(ws.back)) || '' };
  const root = ws.touched?.repoRoot || '';
  const dir = root && ws.path.startsWith(root + '/') ? ws.path.slice(root.length + 1).split('/').slice(0, -1).join('/') : '';
  return showFilesBrowser(ws.project, { ...context, mode: 'browse', root, dir });
}
function liveFileRememberOpen(ws) {
  if (fileWs !== ws || ws.recentOpened) return;
  ws.recentOpened = true;
  if (typeof recordRecentFile === 'function') recordRecentFile(ws.path, ws.project);
}
const liveKeyEditors = new WeakSet();
function liveFileAfterMount(ws) {
  if (fileWs !== ws || !ws.editor) return;
  liveFileRememberOpen(ws);
  $('liveBack').onclick = () => liveFileGoBack(ws);
  for (const id of ['liveHistory', 'liveHistoryMenu']) $(id).onclick = () => liveFileHistory(ws);
  for (const id of ['liveAsk', 'liveAskMenu']) $(id).onclick = () => fileWsToggleAsk(true);
  for (const id of ['liveWithConv', 'liveWithConvMenu']) if ($(id)) $(id).onclick = e => { e.currentTarget.closest('details')?.removeAttribute('open'); if (typeof Pair !== 'undefined') Pair.withConversation(ws); };
  if ($('liveBrowse')) $('liveBrowse').onclick = () => liveFileBrowseFolder(ws);
  // The help follows the view: it lists this file's keys, the editor's own included.
  $('liveKeys').onclick = e => { e.currentTarget.closest('details')?.removeAttribute('open'); toggleHelpOverlay(); };
  // AI commands, in any text file whose editor has them (it says why not).
  $('liveAi').onclick = e => {
    e.currentTarget.closest('details')?.removeAttribute('open');
    if (typeof ws.editor.openAiMenu !== 'function') return toast('this editor version has no AI commands — reload the page');
    ws.editor.openAiMenu();
  };
  wireFileViewControls($('ffCompare'));
  const editor = ws.editor;
  // Once per editor: a notebook parked in the side list comes back with the
  // same one, shown by a new workspace.
  if (editor.view?.dom && !liveKeyEditors.has(editor)) {
    liveKeyEditors.add(editor);
    editor.view.dom.addEventListener('keydown', e => {
      const shown = fileWs && fileWs.editor === editor ? fileWs : null;
      if (!shown) return;
      if (modHeld(e) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); fileWsToggleAsk(true); }
      else fileViewKey(shown, e);
    });
  }
  const savedText = ws.kind === 'md' ? docState.baseText : ws.baseText;
  $('docReload').onclick = () => liveFileReload(ws);
  const state = ws.live = { version: 0, original: savedText, sha: ws.kind === 'md' ? docState.sha : ws.sha,
    baseline: savedText, label: 'since opening', absent: false, origins: null, mappedVersion: -1, marks: new Map(),
    busy: false, timer: null, pending: false, controller: new AbortController(), blame: new Map(), hover: 0, disposed: false };
  const status = text => { if (fileWs === ws && $('liveAnnotationStatus')) $('liveAnnotationStatus').textContent = text; };
  try {
    state.worker = new Worker('/live-file-marks-worker.js');
    state.worker.onmessage = e => {
      if (fileWs !== ws || state.disposed) return;
      state.busy = false;
      if (e.data.id === state.version) {
        state.origins = e.data.origins || null; state.mappedVersion = e.data.id;
        state.marks = new Map((e.data.marks || []).map(m => [m.line, m]));
        editor.setLineMarks?.(state.marks, editor.getContent());
        status(e.data.unavailable || `Markers: ${state.label}. Hover the gutter for Git attribution.`);
      }
      if (state.pending) send();
    };
    state.worker.onerror = () => { state.worker.terminate(); state.worker = null; state.busy = false; status('Inline annotations unavailable; editing still works'); };
  } catch { status('Inline annotations unavailable; editing still works'); }
  const send = () => {
    if (fileWs !== ws || state.disposed || !state.worker) return;
    if (state.busy) { state.pending = true; return; }
    state.pending = false; state.busy = true;
    state.worker.postMessage({ id: state.version, text: editor.getContent(), baseline: state.baseline, original: state.original, absent: state.absent, label: state.label });
  };
  state.refresh = () => {
    state.version++; state.hover++; state.hoverController?.abort(); clearTimeout(state.timer); state.timer = setTimeout(send, 120);
    clearTimeout(state.draftTimer); state.draftTimer = setTimeout(() => liveFileStash(ws), 300);
  };
  state.unsubscribe = editor.onChange(state.refresh);
  state.refresh();
  const setReview = data => {
    if (fileWs !== ws || state.disposed || !data) return;
    if (!data.old?.unavailable && typeof data.old?.text === 'string') { state.baseline = data.old.text; state.absent = !!data.old.absent; state.label = 'since the review baseline'; state.refresh(); }
    else status('Review baseline unavailable; markers show edits since opening');
  };
  if (ws.reviewData) setReview(ws.reviewData);
  else if (ws.reviewRef) {
    const r = ws.reviewRef;
    fetch('/api/reviews/file?' + new URLSearchParams({ id: r.id, path: r.path, step: r.step || '', scope: r.scope || 'task' }), { signal: state.controller.signal })
      .then(r => r.json()).then(setReview).catch(() => {});
  }
  const language = liveLanguage(ws.path), factory = liveLanguageFactories.get(language);
  if (factory && editor.setLanguageServices) {
    Promise.resolve().then(() => factory({ path: ws.path, project: ws.project, editor, signal: state.controller.signal }))
      .then(service => {
        if (fileWs !== ws || state.disposed) return service?.dispose?.();
        state.service = service; editor.setLanguageServices(service);
        const el = $('liveServiceStatus'); if (el) { el.textContent = service?.name || language; el.title = service ? 'Language-service adapter enabled' : 'Built-in language support'; }
      }).catch(() => { if (fileWs === ws && $('liveServiceStatus')) $('liveServiceStatus').title = 'Language service unavailable; built-in completion remains enabled'; });
  }
  const beforeUnload = event => {
    liveFileStash(ws);
    if (!ws.collab && editor.getContent() !== state.original) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  state.dispose = () => {
    liveFileStash(ws); window.removeEventListener('beforeunload', beforeUnload);
    state.disposed = true; clearTimeout(state.timer); clearTimeout(state.diskTimer); clearTimeout(state.draftTimer); state.controller.abort(); state.hoverController?.abort();
    state.worker?.terminate(); state.unsubscribe?.();
    try { Promise.resolve(state.service?.dispose?.()).catch(() => {}); } catch {}
  };
  editor.focus();
}
async function liveFileHover(ws, line) {
  const s = ws?.live;
  if (!s || fileWs !== ws || s.disposed) return '';
  const version = s.version, ticket = ++s.hover;
  s.hoverController?.abort();
  const marker = s.marks.get(line)?.title;
  if (s.mappedVersion !== version || !s.origins) return s.worker ? 'Line information is updating…' : 'Inline annotations unavailable';
  const origin = s.origins[line];
  if (!origin) return [marker, 'Edited in this view · not saved'].filter(Boolean).join('\n');
  const key = s.sha + ':' + origin;
  if (!s.blame.has(key)) {
    const controller = s.hoverController = new AbortController();
    await new Promise(resolve => setTimeout(resolve, 120));
    if (ticket !== s.hover || controller.signal.aborted) return '';
    try {
      const response = await fetch('/api/file/line-info?' + new URLSearchParams({ path: ws.path, line: origin, sha: s.sha, reviewId: ws.reviewRef?.id || '' }), { signal: controller.signal });
      const data = await response.json();
      if (fileWs !== ws || s.version !== version || ticket !== s.hover) return '';
      const label = data.kind === 'git' ? `${data.author} · ${new Date(data.time).toLocaleDateString()}\n${data.commit.slice(0, 10)} · ${data.summary}\nGit attribution` : data.reason || data.error || 'Attribution unavailable';
      s.blame.set(key, label); if (s.blame.size > 200) s.blame.delete(s.blame.keys().next().value);
    } catch { return controller.signal.aborted ? '' : 'Attribution unavailable'; }
  }
  return [marker, s.blame.get(key)].filter(Boolean).join('\n');
}
function liveFileNavigate(ws, location) {
  if (fileWs !== ws || !location || !isFullPath(location.path)) return;
  return openLiveFile(location.path, { project: ws.project, root: ws.touched.repoRoot, line: Number(location.line) || 1, back: fileWsHash(ws) });
}
function liveFileStash(ws) {
  if (!ws?.live || !ws.editor) return;
  // A shared file has no local draft: the server holds the text and the
  // disk follows it. A stale stash here would come back as a "draft" the
  // next time the file opens alone.
  if (ws.collab || ws.wasShared) { try { sessionStorage.removeItem('chattering.draft:' + ws.path); } catch {} return; }
  const text = ws.editor.getContent();
  try {
    const key = 'chattering.draft:' + ws.path;
    if (text === ws.live.original) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({ sha: ws.live.sha, text, at: Date.now() }));
    ws.live.draftWarning = false;
  } catch {
    if (!ws.live.draftWarning) { ws.live.draftWarning = true; errToast('Could not store a recovery draft. Save or copy your edits before leaving.'); }
  }
}
function liveFileSaved(ws, text, sha) {
  const s = ws.live; if (!s) return;
  s.original = text; s.sha = sha; s.blame.clear(); s.refresh();
}
function liveFileActivity(ws) {
  const s = ws.live; if (!s || s.disposed) return;
  clearTimeout(s.diskTimer);
  s.diskTimer = setTimeout(async () => {
    try {
      const d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path, reviewId: ws.reviewRef?.id || '' }), { signal: s.controller.signal })).json();
      if (fileWs !== ws || s.disposed || d.error) return;
      const sha = ws.kind === 'md' ? docState?.sha : ws.sha;
      if (d.sha === sha || d.text === ws.editor.getContent()) return;
      fileWsBanner(ws, 'The file changed on disk. Your editor has not been replaced.', [['Reload from disk', () => liveFileReload(ws)]]);
    } catch {}
  }, 250);
}
function liveFileReload(ws) {
  const dirty = ws.kind === 'md' ? docState?.dirty : ws.dirty;
  if (dirty && !confirm('Discard your unsaved edits and reload the disk file?')) return;
  return ws.kind === 'md' ? reloadDocumentFromDisk() : fileWsReloadCode(ws, { dropDraft: true });
}

// ---- History: recorded versions of this file, read-only ----
// The editor makes way for a version list and one version (or the diff of
// two). Nothing is fetched until History is asked for; the route carries
// the chosen versions so a refresh or a shared link lands on the same view.
async function liveHistoryScope(ws) {
  if (ws.historyScope) return ws.historyScope;
  const out = await (await fetch('/api/file/history-scope?' + new URLSearchParams({ path: ws.path, project: ws.project || '' }))).json();
  if (out.error) throw new Error(out.error);
  ws.historyScope = out;
  if (!ws.touched.repoRoot && out.root) ws.touched.repoRoot = out.root;
  if (!ws.project && out.project) ws.project = out.project;
  return out;
}
function liveHistoryParams(scope) {
  return new URLSearchParams({ scope: 'project', name: scope.project, repo: scope.root, path: scope.relativePath });
}
function liveHistoryHead(ws) {
  return `<header class="live-file-head">
    <button id="liveBack" title="${fgAttr(liveBackLabel(ws).slice(2))}: return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${esc(liveBackLabel(ws).slice(2))}</span></button>
    <b id="ffTitle" title="${fgAttr(ws.path)}">${esc(liveFileLabel(ws))}</b>
    <span id="docStatus" role="status">History · read-only</span>
    <button id="liveLive" class="primary" title="Back to the editable file">Return to Live</button>
  </header>`;
}
async function liveFileHistory(ws, selection = {}) {
  if (fileWs !== ws) return;
  if (ws.placement === 'beside') fileWsToPage(ws);
  const ticket = ws.historyRequest = (ws.historyRequest || 0) + 1;
  if (ws.editor) fileWsCloseEditor();
  ws.mode = 'history';
  ws.historySel = selection;
  const view = ws.frame && ws.frame.isConnected ? ws.frame : $('view').querySelector('.live-file-view');
  if (!view) return;
  view.classList.add('history');
  view.innerHTML = liveHistoryHead(ws) + '<div class="live-history"><aside id="fwHistoryDrawer" class="fw-history-drawer" aria-label="File history">Loading recorded versions…</aside><main id="lfHistoryMain" class="lf-history-main"></main></div>';
  $('liveBack').onclick = () => liveFileGoBack(ws);
  $('liveLive').onclick = () => openLiveFile(ws.path, { project: ws.project, root: ws.touched?.repoRoot, back: ws.back, browserContext: ws.browserContext, reviewRef: ws.reviewRef });
  const host = $('fwHistoryDrawer');
  try {
    const scope = await liveHistoryScope(ws);
    const params = liveHistoryParams(scope);
    for (const key of ['from', 'to']) if (/^saved:\d+$/.test(selection[key] || '')) params.set(key, selection[key]);
    const doc = await (await fetch('/api/file-history/points?' + params)).json();
    if (doc.error) throw new Error(doc.error);
    if (fileWs !== ws || ws.historyRequest !== ticket) return;
    const points = doc.points, usable = points.filter(p => p.state !== 'unavailable');
    if (!usable.length) { host.textContent = 'No readable versions have been saved yet.'; return; }
    const newest = [...usable].reverse().find(p => p.kind === 'saved') || usable.at(-1);
    const pick = id => id ? usable.find(p => p.id === id || p.eventId === id) : null;
    if ((selection.to && !pick(selection.to)) || (selection.from && !pick(selection.from))) throw new Error('The requested version is unavailable. Pick another version.');
    let to = pick(selection.to) || newest;
    let from = pick(selection.from) || to;
    if (from.order > to.order) [from, to] = [to, from];
    ws.historySel = { from: from.id, to: to.id };
    const comparing = from.id !== to.id;
    const label = p => p.kind === 'current' ? 'Live file' : p.kind === 'saved' ? p.label : p.kind === 'ai' ? 'Reconstructed · ' + (p.title || 'agent edit') : p.kind === 'git' ? 'Git · ' + (p.subject || p.shortHash) : p.label || 'Recorded boundary';
    const when = p => p.kind === 'current' ? 'Now' : esc(new Date(p.ms).toLocaleString());
    host.innerHTML = `<header><b>History</b></header>
      <p class="fh-truth">${esc(doc.truth)}</p>
      <label><input id="fhCompare" type="checkbox" ${comparing ? 'checked' : ''}> Compare two versions</label>
      <label id="fhFromLabel" ${comparing ? '' : 'hidden'}>From <select id="fhFrom" aria-label="Earlier version"></select></label>
      <label>To <select id="fhTo" aria-label="Version to read"></select></label>
      <nav class="fh-step"><button id="fhOlder">← Older</button><button id="fhNewer">Newer →</button></nav>
      <p class="fh-readonly" role="status">Read-only · ${to.state === 'deleted' ? 'Deletion observed' : to.kind === 'current' ? 'Current disk contents' : 'Recorded ' + new Date(to.ms).toLocaleString()}</p>
      <div class="fh-versions">${[...points].reverse().map(p => `<button data-fh-point="${esc(p.id)}" ${p.state === 'unavailable' ? 'disabled' : ''} aria-current="${p.id === to.id ? 'true' : 'false'}"><time>${when(p)}</time><span>${esc(label(p))}</span></button>`).join('')}</div>`;
    const options = [...usable].reverse().map(p => `<option value="${esc(p.id)}">${when(p)} · ${esc(label(p))}</option>`).join('');
    $('fhFrom').innerHTML = $('fhTo').innerHTML = options;
    $('fhFrom').value = from.id; $('fhTo').value = to.id;
    const select = (toId, fromId) => liveFileHistory(ws, { from: fromId || toId, to: toId });
    const i = usable.findIndex(p => p.id === to.id);
    $('fhCompare').onchange = () => select(to.id, $('fhCompare').checked ? usable[Math.max(0, i - 1)].id : to.id);
    $('fhFrom').onchange = () => select(to.id, $('fhFrom').value);
    $('fhTo').onchange = () => select($('fhTo').value, comparing ? from.id : null);
    $('fhOlder').disabled = i <= 0; $('fhNewer').disabled = i >= usable.length - 1;
    $('fhOlder').onclick = () => select(usable[Math.max(0, i - 1)].id, comparing ? from.id : null);
    $('fhNewer').onclick = () => select(usable[Math.min(usable.length - 1, i + 1)].id, comparing ? from.id : null);
    host.querySelectorAll('[data-fh-point]').forEach(b => b.onclick = () => select(b.dataset.fhPoint, comparing ? from.id : null));
    replaceRoute(fileWsHash(ws));
    await liveHistoryPaint(ws, scope, doc, from, to, ticket);
    if (ws.historyRequest === ticket) liveFileRememberOpen(ws);
  } catch (e) { if (fileWs === ws && host.isConnected && ws.historyRequest === ticket) host.textContent = 'History unavailable: ' + e.message; }
}
async function liveHistorySnapshot(scope, doc, point) {
  const params = liveHistoryParams(scope);
  params.set('point', point.id);
  const snap = await (await fetch('/api/file-history/snapshot?' + params)).json();
  if (snap.error) throw new Error(snap.error);
  return snap;
}
function liveVersionHtml(snap) {
  if (snap.state === 'deleted') return '<p class="cr-diff-notice">The file was absent at this point.</p>';
  const lines = String(snap.content || '').split('\n');
  return `<pre class="lf-version"><code>${lines.map((line, i) => `<span class="lf-ln">${i + 1}</span>${esc(line)}\n`).join('')}</code></pre>`;
}
async function liveHistoryPaint(ws, scope, doc, from, to, ticket) {
  const main = $('lfHistoryMain');
  if (!main) return;
  main.innerHTML = '<p class="cr-diff-notice">Loading the recorded version…</p>';
  const comparing = from.id !== to.id;
  const [older, newer] = await Promise.all([comparing ? liveHistorySnapshot(scope, doc, from) : null, liveHistorySnapshot(scope, doc, to)]);
  if (fileWs !== ws || ws.historyRequest !== ticket || !main.isConnected) return;
  const note = s => s && !s.exact && s.state !== 'deleted' ? `<p class="cr-diff-notice">${esc(s.method === 'replay' ? 'Reconstructed from recorded edits; divergent edits may have been skipped.' : 'Approximate version.')}</p>` : '';
  if (!comparing) { main.innerHTML = note(newer) + liveVersionHtml(newer); return; }
  const side = s => ({ text: String(s.content || ''), absent: s.state === 'deleted' });
  ws.historyExpanded = ws.historyExpanded || [];
  const paint = () => {
    main.innerHTML = note(older) + note(newer) + `<div class="cr-diff">${crDiff(side(older), side(newer), { comments: false, expanded: ws.historyExpanded })}</div>`;
    main.querySelectorAll('[data-cr-expand]').forEach(b => b.onclick = () => { ws.historyExpanded.push(b.dataset.crExpand.split(':').map(Number)); paint(); });
  };
  paint();
}

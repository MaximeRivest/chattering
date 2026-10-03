'use strict';
// Read-only viewers share the file workspace, not the text editor's lifecycle.
function fileViewerQuery(ws) {
  const conv = typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
  return new URLSearchParams({ id: conv || '', path: ws.path });
}
function fileViewerURL(ws, download = false) {
  const query = fileViewerQuery(ws);
  if (download) query.set('download', '1');
  return '/api/file/media?' + query;
}
async function fileViewerJSON(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ error: response.status === 401 ? 'Sign in again, then reload this file.' : 'The server did not return a valid response. Try Reload.' }));
  if (!response.ok || data.error) throw Error(data.error || `Could not open the file (${response.status}).`);
  return data;
}
function fileViewerFrame(ws, kind) {
  ws.mediaView?.dispose();
  ws.readOnly = true;
  $('ffCompare').innerHTML = `<div class="doc-view lf-media-view">
    <header class="live-file-head lf-media-head">
      <button id="liveBack" title="Return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${esc(liveBackLabel(ws).slice(2))}</span></button>
      ${liveFileNameHtml(ws)}
      <span id="docStatus" role="status">Opening ${kind}…</span>
      <button id="mediaReload">Reload</button>
      <a id="mediaDownload" href="${fgAttr(fileViewerURL(ws, true))}" download>Download</a>
    </header>
    <div id="mediaHost" class="lf-media-host"><p id="mediaMessage" class="lf-media-message" role="status">Opening ${kind}…</p></div>
  </div>`;
  const controller = new AbortController(), cleanups = [];
  const state = ws.mediaView = { disposed: false, controller, cleanups,
    dispose() { if (state.disposed) return; state.disposed = true; controller.abort(); for (const cleanup of cleanups) cleanup(); } };
  state.current = () => fileWs === ws && ws.mediaView === state && !state.disposed;
  state.host = $('mediaHost'); state.message = $('mediaMessage'); state.status = $('docStatus');
  state.fail = text => {
    if (!state.current()) return;
    state.message.textContent = text; state.message.hidden = false; state.status.textContent = 'Could not open ' + kind;
  };
  $('liveBack').onclick = () => liveFileGoBack(ws);
  $('mediaReload').onclick = () => fileWsMountBody(ws, {});
  return state;
}
// Where a PDF or a video was left (its page, its time), per file on this
// device, so opening it again, from the side list or anywhere, goes on
// from there, as a text file's cursor does.
function fileViewerPlace(ws) {
  try { return Number(localStorage.getItem('chattering.place:' + ws.path)) || 0; } catch { return 0; }
}
function setFileViewerPlace(ws, value) {
  try { if (value > 0) localStorage.setItem('chattering.place:' + ws.path, String(value)); else localStorage.removeItem('chattering.place:' + ws.path); } catch {}
}
// The last stretch of a video counts as its end: two seconds, or a tenth of
// a short clip.
const videoEndMargin = video => Math.min(2, video.duration / 10);
async function liveFileMountVideo(ws) {
  if (fileWs !== ws || !$('ffCompare')) return;
  const state = fileViewerFrame(ws, 'video');
  try {
    await fileViewerJSON('/api/path/info?' + fileViewerQuery(ws), { signal: state.controller.signal });
    if (!state.current()) return;
    const video = document.createElement('video');
    video.id = 'fileVideo'; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    video.setAttribute('aria-label', ws.path.split(/[\\/]/).pop());
    state.host.classList.add('lf-video-host'); state.host.prepend(video);
    video.onloadedmetadata = () => {
      if (!state.current()) return;
      const at = fileViewerPlace(ws);
      if (at > 0 && Number.isFinite(video.duration) && at < video.duration - videoEndMargin(video)) video.currentTime = at;
      state.message.hidden = true;
      state.status.textContent = `${video.videoWidth} × ${video.videoHeight} · Read-only`;
      liveFileRememberOpen(ws);
    };
    video.onerror = () => state.fail(video.error?.code === 2
      ? 'The video could not be loaded. Check your connection and try Reload.'
      : 'This device could not play the video. Its format may be unsupported or the file may be damaged. You can download it to use another player.');
    // The time, when it settles: a pause, a seek, and the leaving itself.
    // Near the end counts as watched: next time starts from the beginning.
    const remember = () => { if (Number.isFinite(video.duration) && video.duration > 0) setFileViewerPlace(ws, video.currentTime < video.duration - videoEndMargin(video) ? video.currentTime : 0); };
    video.addEventListener('pause', remember);
    video.addEventListener('seeked', remember);
    state.cleanups.push(() => { remember(); video.onloadedmetadata = video.onerror = null; video.removeEventListener('pause', remember); video.removeEventListener('seeked', remember); video.pause(); video.removeAttribute('src'); video.load(); });
    video.src = fileViewerURL(ws) + '&v=' + Date.now();
  } catch (error) { if (state.current()) state.fail(error.message); }
}
async function liveFileMountPDF(ws) {
  if (fileWs !== ws || !$('ffCompare')) return;
  const state = fileViewerFrame(ws, 'PDF');
  try {
    await fileViewerJSON('/api/path/info?' + fileViewerQuery(ws), { signal: state.controller.signal });
    if (!state.current()) return;
    const frame = document.createElement('iframe');
    frame.id = 'filePDF'; frame.className = 'lf-preview-frame'; frame.title = 'PDF reader: ' + ws.path.split(/[\\/]/).pop();
    frame.referrerPolicy = 'no-referrer';
    const onMessage = event => {
      if (!state.current() || event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'chattering:pdf') return;
      if (event.data.error) return state.fail(event.data.error);
      if (event.data.page) return setFileViewerPlace(ws, event.data.page > 1 ? event.data.page : 0);
      state.message.hidden = true;
      state.status.textContent = `${event.data.pages} pages · Read-only`;
      liveFileRememberOpen(ws);
    };
    window.addEventListener('message', onMessage);
    state.cleanups.push(() => { window.removeEventListener('message', onMessage); frame.remove(); });
    state.host.append(frame);
    const query = new URLSearchParams({ file: fileViewerURL(ws), eink: document.documentElement.dataset.themeMode === 'binary' ? '1' : '0', page: String(fileViewerPlace(ws) || '') });
    frame.src = '/vendor/pdfjs/6.3.289/web/viewer.html?' + query;
  } catch (error) { if (state.current()) state.fail(error.message); }
}

// Source stays mounted while Preview is visible: switching never discards edits,
// changes their base hash, or saves them implicitly.
function liveFileEnableHTML(ws, opts = {}) {
  if (fileWs !== ws || !ws.editor || !$('htmlPreview')) return;
  $('htmlSource').onclick = () => liveFileShowHTML(ws, false);
  $('htmlPreview').onclick = () => liveFileShowHTML(ws, true);
  if (opts.preview === '1') liveFileShowHTML(ws, true);
}
async function liveFileShowHTML(ws, preview) {
  if (fileWs !== ws || !ws.editor) return;
  ws.htmlPreview?.dispose();
  ws.htmlPreviewOpen = preview;
  const code = $('ffCompare').querySelector('.code-host');
  code.hidden = preview;
  $('htmlSource').setAttribute('aria-pressed', String(!preview));
  $('htmlPreview').setAttribute('aria-pressed', String(preview));
  setRoute('file', fileWsHash(ws));
  if (!preview) { ws.editor.focus(); return; }
  const host = document.createElement('section'); host.className = 'lf-html-preview';
  const saving = ws.collab ? 'Shared editor — edits save as you type.' : 'Preview of current edits — not saved automatically.';
  host.innerHTML = `<div class="lf-html-note"><span>${saving} Scripts, forms, outside websites and links are disabled; assets stay inside this file’s folder (32 MB per asset).</span><button id="htmlRefresh">Refresh preview</button></div><p class="lf-media-message" role="status">Preparing preview…</p>`;
  code.after(host);
  const message = host.querySelector('[role=status]');
  const state = ws.htmlPreview = { disposed: false, token: null, dispose() {
    if (state.disposed) return;
    state.disposed = true; host.remove();
    if (state.token) fetch('/api/file/preview?token=' + state.token, { method: 'DELETE', keepalive: true }).catch(() => {});
  } };
  const current = () => fileWs === ws && ws.htmlPreview === state && !state.disposed;
  $('htmlRefresh').onclick = () => liveFileShowHTML(ws, true);
  const source = ws.editor.getContent();
  try {
    const module = await import('/html-preview.js');
    if (!current()) return;
    // Do not abort this small grant request: always receive and revoke a grant
    // that arrived after navigation, rather than leaving it alive until expiry.
    const grant = await fileViewerJSON('/api/file/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fileViewerQuery(ws))) });
    state.token = grant.token;
    if (!current()) { fetch('/api/file/preview?token=' + grant.token, { method: 'DELETE', keepalive: true }).catch(() => {}); return; }
    const frame = document.createElement('iframe'); frame.id = 'fileHTML'; frame.className = 'lf-preview-frame';
    frame.title = 'HTML preview: ' + ws.path.split(/[\\/]/).pop();
    frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer';
    frame.onload = () => { if (current()) { message.hidden = true; liveFileRememberOpen(ws); } };
    frame.srcdoc = module.prepareHTML(source, new URL(grant.base, location.origin).href);
    host.append(frame);
  } catch (error) { if (current()) message.textContent = 'Could not prepare the preview. ' + error.message; }
}

// CSV and TSV (table-view.js): Table or Text, like HTML's Preview or Source.
// The text editor stays mounted under the table: switching never loses
// edits, and the table shows the text as it is in the editor, saved or not.
// The choice is the device's (a reader of data opens tables; someone who
// edits them may prefer the text), and the route's when a link names it.
const TABLE_PREF_KEY = 'chattering.tableView.v1';
function liveFileEnableTable(ws, opts = {}) {
  if (fileWs !== ws || !ws.editor || !$('tableOn')) return;
  $('tableOn').onclick = () => liveFileShowTable(ws, true, { remember: true });
  $('tableOff').onclick = () => liveFileShowTable(ws, false, { remember: true });
  let pref = 'table';
  try { pref = localStorage.getItem(TABLE_PREF_KEY) || 'table'; } catch {}
  const asked = opts.table === '1' || opts.table === 1 ? true : opts.table === '0' || opts.table === 0 ? false : null;
  // Back from the side list (parked), it shows as it was left.
  const on = asked ?? (opts.resumed && ws.tableOpen != null ? ws.tableOpen : pref !== 'text');
  liveFileShowTable(ws, on, { route: false });
}
function liveFileShowTable(ws, on, { remember = false, route = true } = {}) {
  if (fileWs !== ws || !ws.editor) return;
  ws.tableView?.dispose();
  ws.tableView = null;
  ws.tableOpen = on;
  if (remember) { try { localStorage.setItem(TABLE_PREF_KEY, on ? 'table' : 'text'); } catch {} }
  const code = $('ffCompare').querySelector('.code-host');
  if (!code) return;
  code.hidden = on;
  code.parentElement.querySelector('.lf-table-view')?.remove();
  $('tableOn').setAttribute('aria-pressed', String(on));
  $('tableOff').setAttribute('aria-pressed', String(!on));
  // Beside a conversation the route is the conversation's.
  if (route && ws.placement !== 'beside') setRoute('file', fileWsHash(ws));
  if (!on) { ws.editor.focus(); return; }
  const host = document.createElement('section');
  host.className = 'lf-table-view';
  code.after(host);
  const state = ws.tableState || (ws.tableState = {});
  const view = TableView.mount(host, ws.editor.getContent(), { path: ws.path, state });
  let timer = 0;
  ws.tableView = {
    changed() { clearTimeout(timer); timer = setTimeout(() => { if (ws.tableView && fileWs === ws && ws.editor) view.update(ws.editor.getContent()); }, 250); },
    focusFilter: () => view.focusFilter(),
    dispose() { clearTimeout(timer); view.dispose(); host.remove(); },
  };
  liveFileRememberOpen(ws);
}

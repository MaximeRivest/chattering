'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { viewerBrowser, samplePDF } = require('./helpers/viewer-browser');

test('media and HTML viewers: real server, desktop, phone, tablet and security boundaries', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t);
  const { work, base, auth, evaluate: run, until, open, command, size } = b;
  fs.writeFileSync(path.join(work, 'reader & notes.pdf'), samplePDF(512 * 1024));
  fs.writeFileSync(path.join(work, 'broken.pdf'), 'not a PDF');
  fs.copyFileSync(path.join(__dirname, 'fixtures/media/password.pdf'), path.join(work, 'password.pdf'));
  for (const ext of ['webm', 'mp4']) fs.copyFileSync(path.join(__dirname, 'fixtures/media/clip.' + ext), path.join(work, 'clip.' + ext));
  fs.writeFileSync(path.join(work, 'broken.mp4'), 'not a video');
  const mediaURL = file => base + '/api/file/media?' + new URLSearchParams({ path: path.join(work, file) });
  const remote = { 'X-Forwarded-For': '100.100.100.100' }, signedIn = { ...remote, Cookie: 'chattering=viewer-test-token' };
  assert.equal((await fetch(mediaURL('clip.webm'), { headers: remote })).status, 401, 'remote media needs login');
  const partial = await fetch(mediaURL('clip.webm'), { headers: { ...signedIn, Range: 'bytes=10-99' } });
  assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 90);
  const outside = path.join(b.home, 'private.pdf'); fs.writeFileSync(outside, samplePDF());
  assert.equal((await fetch(base + '/api/file/media?' + new URLSearchParams({ path: outside }), { headers: signedIn })).status, 404, 'remote path stays scoped to projects');
  fs.symlinkSync(outside, path.join(work, 'escape.pdf'));
  assert.equal((await fetch(mediaURL('escape.pdf'), { headers: signedIn })).status, 404, 'a project symlink cannot grant access');

  // Native controls, no autoplay, seeking, teardown and a clear codec failure.
  for (const ext of ['webm', 'mp4']) {
    await open('clip.' + ext); await until(`$('fileVideo')?.readyState>=1`, ext + ' metadata');
    assert.equal(await run(`$('fileVideo').paused && $('fileVideo').playsInline && $('fileVideo').controls`), true);
    assert.equal(await run(`$('fileVideo').videoWidth`), 320);
    await run(`$('fileVideo').currentTime=1.5`); await until(`!$('fileVideo').seeking && $('fileVideo').readyState>=2`, 'seek completes');
    await run(`window.previousVideo=$('fileVideo');previousVideo.muted=true;previousVideo.play()`);
    await until(`!$('fileVideo').paused`, 'video plays');
    await open('broken.mp4'); await until(`$('mediaMessage').textContent.includes('could not play')`, 'unsupported video error');
    assert.equal(await run(`previousVideo.paused && !previousVideo.getAttribute('src')`), true, 'navigation stops and detaches playback');
  }
  // A delayed conversation load cannot replace a file opened in the meantime.
  await run(`window.viewerFetch=window.fetch;window.fetch=(url,opts)=>String(url).startsWith('/api/session?')?new Promise(resolve=>{window.releaseSession=()=>viewerFetch(url,opts).then(resolve)}):viewerFetch(url,opts);window.pendingConversation=open('pi:fixture/media.jsonl');void 0`);
  await open('clip.webm');
  await run(`(async()=>{window.fetch=viewerFetch;releaseSession();await pendingConversation})()`);
  assert.equal(await run(`viewKind==='file' && !!$('fileVideo')`), true, 'stale conversation cannot overwrite the file viewer');
  await size(390, 844, true); await open('clip.webm'); await until(`$('fileVideo')?.readyState>=1`);
  assert.ok(await run(`$('fileVideo').currentTime`) >= 1.4, 'a video opens again where it was left');
  assert.equal(await run(`$('fileVideo').getBoundingClientRect().right<=innerWidth && document.documentElement.scrollWidth<=innerWidth`), true);
  assert.equal(await run(`$('mediaReload').getBoundingClientRect().height>=44 && $('mediaDownload').getBoundingClientRect().height>=44`), true);
  await b.screenshot('file-video-phone.png');
  await size(844, 390, true);
  assert.equal(await run(`$('fileVideo').getBoundingClientRect().bottom<=innerHeight+1`), true, 'video controls stay visible in phone landscape');
  await size(390, 844, true);

  // Mozilla's complete viewer: render, select text, find, page navigation and zoom.
  await open('reader & notes.pdf');
  const pdf = `$('filePDF').contentWindow.PDFViewerApplication`;
  await until(`${pdf}?.pdfDocument?.numPages===3 && ${pdf}.pdfViewer.getPageView(0)?.renderingState===3`, 'PDF renders on phone');
  // The text layer follows the drawn page: wait for it rather than read once.
  await until(`${pdf}.appConfig.viewerContainer.querySelectorAll('.textLayer span').length>0`, 'text layer is selectable');
  assert.equal(await run(`$('filePDF').contentDocument.documentElement.dataset.toolbarDensity`), 'touch');
  assert.match(await run(`$('docStatus').textContent`), /3 pages/);
  assert.equal(await run(`$('filePDF').contentWindow.PDFViewerApplicationOptions.get('enableScripting')`), false);
  assert.equal(await run(`$('filePDF').contentWindow.PDFViewerApplicationOptions.get('annotationEditorMode')`), -1);
  await run(`${pdf}.eventBus.dispatch('find', {source:window,type:'',query:'apricot',phraseSearch:true,caseSensitive:false,entireWord:false,highlightAll:true,findPrevious:false})`);
  await until(`${pdf}.findController.pageMatches.reduce((n,p)=>n+p.length,0)===3`, 'PDF search finds all pages');
  await run(`${pdf}.page=2`); await until(`${pdf}.pdfViewer.currentPageNumber===2 && ${pdf}.pdfViewer.getPageView(1)?.renderingState===3`);
  await run(`${pdf}.pdfViewer.currentScaleValue='1.5'`); assert.equal(await run(`${pdf}.pdfViewer.currentScale`), 1.5);
  assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`), true, 'PDF zoom stays within its frame');
  await run(`${pdf}.pdfViewer.currentScaleValue='page-width'`);
  await until(`${pdf}.pdfViewer.getPageView(1)?.renderingState===3`);
  await b.screenshot('file-pdf-phone.png');
  assert.ok(b.requests.some(r => r.url.includes('/api/file/media?') && Object.keys(r.headers).some(k => k.toLowerCase() === 'range')), 'media readers request ranges');
  // The page it is left on is where it opens again.
  await run(`${pdf}.page=2`);
  await until(`Object.entries(localStorage).some(([k, v]) => k.startsWith('chattering.place:') && k.endsWith('reader & notes.pdf') && v === '2')`, 'the PDF page is remembered');
  await size(1024, 1366, true); await run(`$('mediaReload').click()`);
  await until(`${pdf}?.pdfDocument?.numPages===3 && ${pdf}.pdfViewer.currentPageNumber===2 && ${pdf}.pdfViewer.getPageView(1)?.renderingState===3`, 'PDF reload on tablet, at the page it was left on');
  await b.screenshot('file-pdf-tablet.png');
  await run(`document.documentElement.dataset.themeMode='binary'`);
  await open('password.pdf');
  await until(`$('filePDF').contentDocument.querySelector('#passwordDialog')?.open`, 'encrypted PDF requests its password');
  await run(`$('filePDF').contentDocument.querySelector('#password').value='reader-password';$('filePDF').contentDocument.querySelector('#passwordSubmit').click()`);
  await until(`${pdf}?.pdfDocument?.numPages===3 && ${pdf}.pdfViewer.getPageView(0)?.renderingState===3`, 'password unlocks PDF');
  assert.equal(await run(`$('filePDF').contentDocument.documentElement.dataset.eink`), 'true');
  assert.equal(await run(`$('filePDF').contentWindow.PDFViewerApplicationOptions.get('viewerCssTheme')`), 1);
  await b.screenshot('file-pdf-eink.png');
  await run(`delete document.documentElement.dataset.themeMode`);
  await open('broken.pdf'); await until(`$('mediaMessage').textContent.includes('could not be opened')`, 'corrupt PDF has recovery actions');
  assert.equal(await run(`!!$('mediaDownload') && !!$('mediaReload') && !!$('liveBack')`), true);

  // External resources cannot leak preview contents or use the app's APIs.
  const leaks = [];
  const trap = http.createServer((req, res) => { leaks.push(req.url); res.end('trap'); });
  await new Promise(r => trap.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => trap.close(r)));
  const remoteURL = 'http://127.0.0.1:' + trap.address().port;
  fs.mkdirSync(path.join(work, 'site')); fs.mkdirSync(path.join(work, 'site/styles'));
  fs.writeFileSync(path.join(work, 'site/styles/site.css'), '@import "colors.css"; h1 {font-size:30px}');
  fs.writeFileSync(path.join(work, 'site/styles/colors.css'), 'h1 { color:rgb(11, 90, 42); }');
  fs.writeFileSync(path.join(work, 'site/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=', 'base64'));
  const source = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${remoteURL}/refresh"><base href="${remoteURL}/"><link rel="stylesheet" href="styles/site.css"><style>@import '${remoteURL}/import.css'; body{margin:16px} .remote{background:url('${remoteURL}/background')}</style></head><body><h1>Saved version</h1><img id="local" src="pixel.png"><img src="${remoteURL}/image" onerror="parent.stolen=true"><iframe src="${remoteURL}/iframe"></iframe><script>parent.stolen=true;fetch('${remoteURL}/script')</script><a href="${remoteURL}/link" ping="${remoteURL}/ping">External</a><form action="${remoteURL}/form"><input autofocus name="secret"><button>Submit</button></form><div class="remote">Static preview</div></body></html>`;
  fs.writeFileSync(path.join(work, 'site/index.html'), source);
  // Exercise the explicit-save/recovery path of a server without WebSocket
  // collaboration. Also cover the normal shared editor below; Preview must
  // preserve whichever saving policy the editor already uses.
  const offlineSharing = `window.viewerRealWebSocket=window.WebSocket;window.WebSocket=class extends window.viewerRealWebSocket {constructor(url,protocols){super(String(url).replace('/api/collab/','/api/no-collab/'),protocols)}}`;
  const offlineScript = await command('Page.addScriptToEvaluateOnNewDocument', { source: offlineSharing });
  await run(offlineSharing);
  await size(390, 844, true); await open('site/index.html'); await until(`!!fileWs?.editor`);
  await run(`fileWs.editor.setContent(fileWs.editor.getContent().replace('Saved version','Unsaved version'));$('htmlPreview').click()`);
  await until(`!!$('fileHTML') && $('fileHTML').srcdoc.includes('Unsaved version')`, 'preview uses the unsaved editor buffer');
  assert.equal(fs.readFileSync(path.join(work, 'site/index.html'), 'utf8'), source, 'preview never saves');
  assert.equal(await run(`$('fileHTML').getAttribute('sandbox')`), '');
  assert.equal(await run(`$('fileHTML').contentDocument===null && !window.stolen`), true, 'preview has an opaque origin');
  await until(`$('fileHTML').parentElement.querySelector('[role=status]').hidden`, 'sandboxed HTML loads');
  const htmlContext = await b.frameContext('fileHTML');
  await until(`document.querySelector('#local').naturalWidth===1 && getComputedStyle(document.querySelector('h1')).color==='rgb(11, 90, 42)'`, 'local CSS imports and images load', htmlContext);
  assert.equal(await run(`document.querySelector('h1').textContent`, htmlContext), 'Unsaved version');
  assert.equal(await run(`!document.querySelector('script,iframe') && !document.querySelector('a').hasAttribute('href') && document.querySelector('input').disabled`, htmlContext), true);
  assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`), true);
  await b.screenshot('file-html-phone.png');
  const grant = await run(`fileWs.htmlPreview.token`);
  const assetURL = base + '/api/file/preview-assets/' + grant + '/styles/site.css';
  const asset = await fetch(assetURL, { headers: remote }); assert.equal(asset.status, 200, 'opaque frame uses capability without app cookies'); assert.equal(asset.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(base + '/api/file/preview-assets/' + grant + '/index.html', { headers: remote })).status, 404, 'grant cannot serve HTML');
  await new Promise(r => setTimeout(r, 300)); assert.deepEqual(leaks, [], 'no external HTML/CSS requests escaped');
  await run(`$('htmlSource').click()`);
  assert.equal(await run(`fileWs.editor.getContent().includes('Unsaved version') && fileWs.dirty && !document.querySelector('.code-host').hidden`), true);
  await until(`!document.querySelector('#fileHTML')`);
  await new Promise(r => setTimeout(r, 100)); assert.equal((await fetch(assetURL, { headers: remote })).status, 404, 'leaving preview revokes assets');
  await run(`$('htmlPreview').click()`); await until(`!!$('fileHTML')`);
  await run(`window.beforePreviewReload=true`);
  await command('Page.reload'); await until(`!window.beforePreviewReload && !!$('fileHTML') && $('fileHTML').srcdoc.includes('Unsaved version')`, 'preview deep link and unsaved draft survive reload');
  await run(`$('liveBack').click()`); await until(`viewKind==='conversation' && activeRel==='pi:fixture/media.jsonl'`, 'Back returns to conversation');
  assert.deepEqual(leaks, []);
  await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: offlineScript.result.identifier });
  // The editor bundle can retain its original WebSocket constructor. Reload
  // without the offline injection before exercising the real shared provider.
  await run(`window.beforeOnlineReload=true`);
  await command('Page.reload');
  await until(`!window.beforeOnlineReload && !!window.chatteringMe && viewKind==='conversation' && !!$('agentText')`, 'online conversation fully mounted after reload');
  fs.writeFileSync(path.join(work, 'site/shared.html'), '<h1>Shared source</h1>');
  await open('site/shared.html');
  await until(`!!fileWs?.editor`, 'shared HTML editor mounts');
  if (!await run(`!!fileWs.collab`)) {
    const diagnostic = await run(`collabJoin('file:'+fileWs.path,{timeoutMs:2000}).then(s=>{collabLeave(s);return 'join works'}).catch(e=>String(e.stack))`);
    assert.fail('Shared editor did not join: ' + diagnostic);
  }
  await run(`fileWs.editor.setContent('<h1>Shared edit</h1>');$('htmlPreview').click()`);
  await until(`$('fileHTML')?.srcdoc.includes('Shared edit')`, 'shared editor buffer is previewed');
  assert.match(await run(`document.querySelector('.lf-html-note').textContent`), /edits save as you type/);
  await run(`$('htmlSource').click()`);
  assert.equal(await run(`fileWs.editor.getContent()`), '<h1>Shared edit</h1>');

  // New media routes and cookie-free asset capabilities respect live sharing.
  const added = await (await fetch(base + '/api/users/add', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Viewer test member' }) })).json();
  const secret = new URL(added.inviteLink).searchParams.get('token');
  const member = { ...remote, Cookie: 'chattering=' + secret, 'Content-Type': 'application/json' };
  const issued = await (await fetch(base + '/api/file/preview', { method: 'POST', headers: member, body: JSON.stringify({ path: path.join(work, 'site/index.html') }) })).json();
  assert.ok(issued.token, issued.error);
  const memberAsset = base + issued.base + 'styles/site.css';
  assert.equal((await fetch(memberAsset, { headers: remote })).status, 200);
  const project = (await (await fetch(base + '/api/sessions', { headers: auth })).json()).find(s => s.key === 'pi:fixture/media.jsonl').project;
  const sharing = await fetch(base + '/api/access', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ project, mode: 'listed' }) });
  assert.equal(sharing.status, 200);
  assert.equal((await fetch(mediaURL('clip.webm'), { headers: member })).status, 404, 'hidden project cannot be read through media');
  assert.equal((await fetch(memberAsset, { headers: remote })).status, 404, 'sharing changes invalidate an already-issued capability');
  assert.deepEqual(b.exceptions, []);
});

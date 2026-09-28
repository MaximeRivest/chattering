// Bootstrap the pinned, otherwise unmodified Mozilla viewer with a read-only,
// embedded policy before PDFViewerApplication.run reads its preferences.
const PDF_ROOT = '/vendor/pdfjs/6.3.289';
const notify = data => parent.postMessage({ type: 'chattering:pdf', ...data }, location.origin);
let documentLoadError = false;
// The stock viewer reports documenterror and then rethrows the loading promise.
// Our outer viewer already presents that expected failure with recovery actions.
window.addEventListener('unhandledrejection', event => {
  if (documentLoadError && ['InvalidPDFException', 'ResponseException', 'PasswordException'].includes(event.reason?.name)) event.preventDefault();
});
const configure = event => {
  if (event.detail?.source !== window) return;
  parent.document.removeEventListener('webviewerloaded', configure);
  const options = window.PDFViewerApplicationOptions;
  const eink = new URLSearchParams(location.search).get('eink') === '1';
  const touch = matchMedia('(pointer: coarse)').matches || innerWidth < 700;
  options.setAll({
    disablePreferences: true, disableHistory: true, defaultUrl: '',
    enableScripting: false, enableXfa: false, annotationEditorMode: -1, annotationMode: 1,
    enableAltTextModelDownload: false, enableGuessAltText: false,
    enableSignatureEditor: false, enableComment: false, enableWebGPU: false,
    externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer nofollow',
    disableAutoFetch: true, disableStream: true, defaultZoomValue: 'page-width',
    maxCanvasPixels: touch ? 8 * 1024 * 1024 : 16 * 1024 * 1024,
    toolbarDensity: touch ? 2 : 0, viewerCssTheme: eink ? 1 : 0,
  });
  if (eink) document.documentElement.dataset.eink = 'true';
  window.PDFViewerApplication.initializedPromise.then(() => {
    const app = window.PDFViewerApplication;
    // The page the reader was on last time (the host remembers it per file).
    const start = Number(new URLSearchParams(location.search).get('page')) || 0;
    app.eventBus.on('pagesinit', () => {
      if (start > 1 && start <= app.pdfDocument.numPages) app.page = start;
      notify({ pages: app.pdfDocument.numPages });
    });
    app.eventBus.on('pagechanging', event => notify({ page: event.pageNumber }));
    app.eventBus.on('documenterror', () => {
      documentLoadError = true;
      notify({ error: 'This PDF could not be opened. It may be damaged, unavailable, or use an unsupported feature. Try Reload or Download.' });
    });
  });
};
parent.document.addEventListener('webviewerloaded', configure);
// This is a viewer for the selected server file, not a second file picker.
for (const type of ['drop', 'dragover']) document.addEventListener(type, event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
document.addEventListener('click', event => {
  if (event.target.closest?.('#downloadButton, #secondaryDownload') && parent.document.getElementById('mediaDownload')) {
    event.preventDefault(); event.stopImmediatePropagation(); parent.document.getElementById('mediaDownload').click(); return;
  }
  const link = event.target.closest?.('a[href]');
  if (link && parent.ChatteringApp?.openExternal && /^(https?:|mailto:|tel:)/.test(link.href) && !link.href.startsWith(location.href.split('#')[0] + '#')) {
    event.preventDefault(); event.stopImmediatePropagation(); parent.ChatteringApp.openExternal(link.href);
  }
}, true);
document.addEventListener('keydown', event => {
  // Alt+P keeps the file open in the side list, as it does outside the reader.
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyP' && !event.repeat && parent.OpenFiles) {
    event.preventDefault(); event.stopImmediatePropagation(); parent.OpenFiles.toggleCurrent(); return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'o') { event.preventDefault(); event.stopImmediatePropagation(); }
  if (key === 's' && parent.document.getElementById('mediaDownload')) {
    event.preventDefault(); event.stopImmediatePropagation(); parent.document.getElementById('mediaDownload').click();
  }
}, true);
try { await import(PDF_ROOT + '/web/viewer.mjs'); }
catch {
  parent.document.removeEventListener('webviewerloaded', configure);
  notify({ error: 'The PDF reader could not start. Try Reload; if that does not help, update your browser or download the file.' });
}

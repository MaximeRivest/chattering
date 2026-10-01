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
  const app = window.PDFViewerApplication;
  let resize = null;
  const finishResize = () => {
    const saved = resize;
    if (!saved) return;
    cancelAnimationFrame(saved.frame);
    if (app.pdfDocument === saved.document && app.page !== saved.page) {
      // The page setter resets scrolling even for the same page. Correct
      // only actual drift, preserving the within-page point at any scale.
      app.pdfViewer.scrollPageIntoView({ pageNumber: saved.page,
        destArray: [null, { name: 'XYZ' }, ...saved.point, null],
        allowNegativeOffset: true, ignoreDestinationZoom: true });
    }
    resize = null;
    if (app.pdfDocument === saved.document) notify({ page: app.page });
  };
  // Register before the stock reader binds its resize handler. Its update
  // can briefly select the first visible page at the new geometry; that
  // is not navigation and must not clear the host's remembered place.
  window.addEventListener('resize', () => {
    if (!app.pdfDocument || !app.isInitialViewSet || resize) return;
    const viewer = app.pdfViewer, view = viewer.getPageView(app.page - 1), div = view.div;
    resize = { document: app.pdfDocument, page: app.page,
      point: view.getPagePoint(viewer.container.scrollLeft - div.offsetLeft - div.clientLeft,
        viewer.container.scrollTop - div.offsetTop - div.clientTop) };
    resize.frame = requestAnimationFrame(finishResize);
  }, true);
  // Finish geometry before real navigation so its action starts from the
  // right page and wins. Modifier keys and unrelated clicks are not moves.
  const passiveCapture = { capture: true, passive: true };
  window.addEventListener('wheel', event => { if (event.deltaX || event.deltaY) finishResize(); }, passiveCapture);
  const navigationControl = '#previous,#next,#firstPage,#lastPage,#pageNumber,#findPreviousButton,#findNextButton,.thumbnail,a[href^="#"]';
  const controlNavigation = event => { if (event.target?.closest?.(navigationControl)) finishResize(); };
  window.addEventListener('pointerdown', controlNavigation, passiveCapture);
  // Keyboard activation produces a click with no pointerdown.
  window.addEventListener('click', controlNavigation, passiveCapture);
  window.addEventListener('keydown', event => {
    const editing = event.target?.closest?.('input,textarea,select,[contenteditable="true"]');
    const findAgain = !event.altKey && (event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === 'g';
    const enterNavigation = event.key === 'Enter' && event.target?.closest?.(navigationControl + ',#findInput');
    const pageKey = !editing && !event.altKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',' ','Backspace','j','k','n','p'].includes(event.key);
    if (findAgain || enterNavigation || pageKey) finishResize();
  }, passiveCapture);
  app.initializedPromise.then(() => {
    // The page the reader was on last time (the host remembers it per file).
    const start = Number(new URLSearchParams(location.search).get('page')) || 0;
    app.eventBus.on('pagesinit', () => {
      // pagesinit precedes the stock reader's setInitialView. Changing
      // app.page here is later overwritten by its cached page or zoom.
      if (Number.isInteger(start) && start > 1 && start <= app.pdfDocument.numPages) app.initialBookmark = 'page=' + start + '&zoom=page-width';
      notify({ pages: app.pdfDocument.numPages });
    });
    app.eventBus.on('pagechanging', event => { if (!resize) notify({ page: event.pageNumber }); });
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

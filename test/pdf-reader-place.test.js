'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual integration bootstrap. Only its external module import,
// window geometry and animation-frame scheduler are controlled boundaries.
async function reader(start = 2) {
  const source = fs.readFileSync(path.join(__dirname, '../pdf-viewer-config.js'), 'utf8');
  const importCall = "await import(PDF_ROOT + '/web/viewer.mjs')";
  assert.equal(source.split(importCall).length, 2, 'one bootstrap import boundary');
  const events = new Map(), windowEvents = new Map(), frames = new Map(), messages = [];
  let nextFrame = 0, page = 1, resizeBeforeInit = false, scale = 1;
  const container = { scrollLeft: 0, scrollTop: 0 };
  const pageView = index => ({
    div: { get offsetTop() { return index * 1100 * scale; }, offsetLeft: 0, clientTop: 0, clientLeft: 0 },
    getPagePoint(x, y) { return [x / scale, 800 - y / scale]; },
  });
  const dispatch = (name, value = {}) => { for (const fn of events.get(name) || []) fn(value); };
  const app = {
    pdfDocument: { numPages: 3 }, initializedPromise: Promise.resolve(),
    initialBookmark: null, isInitialViewSet: false,
    eventBus: { on(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); } },
    pdfRenderingQueue: { printing: false },
    pdfViewer: {
      currentScaleValue: null, update() {}, container, getPageView: pageView,
      scrollPageIntoView({ pageNumber, destArray }) {
        app.page = pageNumber;
        container.scrollTop += (800 - destArray[3]) * scale;
        container.scrollLeft = destArray[2] * scale;
      },
    },
    pdfLinkService: { setHash(hash) {
      const value = Number(new URLSearchParams(hash).get('page'));
      if (value) app.page = value;
      const zoom = new URLSearchParams(hash).get('zoom');
      if (zoom) app.pdfViewer.currentScaleValue = zoom;
    } },
  };
  Object.defineProperty(app, 'page', { get: () => page, set: value => {
    // The stock setter scrolls even when its page number is unchanged.
    page = value; container.scrollTop = (value - 1) * 1100 * scale;
    dispatch('pagechanging', { pageNumber: value });
  } });
  Object.defineProperty(app.pdfViewer, 'currentPageNumber', { get: () => page });
  const listeners = new Map();
  const document = { documentElement: { dataset: {} },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    getElementById() { return null; },
  };
  const window = { PDFViewerApplication: app, PDFViewerApplicationOptions: { setAll() {} },
    addEventListener(name, fn, options) {
      if (!windowEvents.has(name)) windowEvents.set(name, []);
      windowEvents.get(name).push({ fn, capture: options === true || !!options?.capture });
    },
  };
  const context = { window, document, location: { origin: 'http://reader.test', search: '?page=' + start },
    parent: { document, postMessage(data, origin) { assert.equal(origin, 'http://reader.test'); messages.push(data); } },
    URLSearchParams, matchMedia: () => ({ matches: false }), innerWidth: 1024,
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    async importViewer() {
      listeners.get('webviewerloaded')({ detail: { source: window } });
      // The stock module binds resize before its initializedPromise settles.
      resizeBeforeInit = (windowEvents.get('resize') || []).length > 0;
    },
  };
  await vm.runInNewContext('(async () => {\n' + source.replace(importCall, "await importViewer(PDF_ROOT + '/web/viewer.mjs')") + '\n})()', context);
  // The pinned viewer's actual setInitialView honors initialBookmark before
  // its cached per-document view. No imitation of that selection logic.
  const vendor = fs.readFileSync(path.join(__dirname, '../vendor/pdfjs/6.3.289/web/viewer.mjs'), 'utf8');
  const startAt = vendor.indexOf('  setInitialView(storedHash, {');
  const endAt = vendor.indexOf('  _cleanup() {', startAt);
  assert.ok(startAt > 0 && endAt > startAt);
  app.setInitialView = vm.runInNewContext('({' + vendor.slice(startAt, endAt) + '}).setInitialView', {
    isValidRotation: () => false, isValidScrollMode: () => false, isValidSpreadMode: () => false,
  });
  const nextAt = vendor.indexOf('  nextPage() {', vendor.indexOf('class PDFViewer {'));
  const previousAt = vendor.indexOf('  previousPage() {', nextAt);
  assert.ok(nextAt > 0 && previousAt > nextAt);
  // Run the real next-page selection with one-page advance as the geometry
  // boundary. Private layout-dependent advance is not reproduced here.
  const NextPage = vm.runInNewContext('(class { #getPageAdvance() { return 1; }' +
    'get _currentPageNumber() { return app.page; } get pagesCount() { return app.pdfDocument.numPages; }' +
    'set currentPageNumber(value) { app.page = value; }' + vendor.slice(nextAt, previousAt) + '})', { app });
  const navigator = new NextPage();
  app.pdfViewer.nextPage = () => navigator.nextPage();
  return {
    app, messages, dispatch, resizeBeforeInit,
    input(type, event = {}) { for (const h of windowEvents.get(type) || []) h.fn(event); },
    scale(value) { scale = value; },
    resize(stockHandler) {
      const handlers = windowEvents.get('resize') || [];
      for (const h of handlers.filter(h => h.capture)) h.fn();
      stockHandler();
      for (const h of handlers.filter(h => !h.capture)) h.fn();
    },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
  };
}

test('Given the stock reader has not initialized, When its bootstrap config runs, Then resize protection already precedes stock binding', async () => {
  const b = await reader(2);
  assert.equal(b.resizeBeforeInit, true, 'install the resize guard before initializedPromise settles');
});

test('Given a remembered PDF page, When pages initialize before the stock cached initial view, Then the remembered page wins', async () => {
  const b = await reader(2);
  b.dispatch('pagesinit');
  b.app.setInitialView('page=1&zoom=page-width');
  assert.equal(b.app.page, 2, 'late stock initial-view selection must not replace the remembered page');
  assert.equal(b.app.pdfViewer.currentScaleValue, 'page-width', 'restoring a page must keep the embedded zoom policy');
});

test('Given the reader is on page two, When responsive resize temporarily reports page one, Then remembered navigation remains page two', async () => {
  const b = await reader(2);
  b.dispatch('pagesinit'); b.app.isInitialViewSet = true; b.app.page = 2;
  const before = b.messages.length;
  b.resize(() => { b.app.page = 1; });
  assert.equal(b.messages.slice(before).some(m => m.page === 1), false,
    'a geometry-only intermediate page must not clear the host bookmark');
  b.flushFrames();
  assert.equal(b.app.page, 2, 'after layout settles the original page is restored');
  assert.equal(b.messages.at(-1).page, 2);
});

test('Given a saved page is out of range, When the stock reader initializes, Then the valid default view remains available', async () => {
  const b = await reader(99);
  b.dispatch('pagesinit'); b.app.setInitialView('page=1&zoom=page-width');
  assert.equal(b.app.page, 1);
});

test('Given resize has queued restoration, When the person navigates to page three, Then delayed layout work cannot undo that choice', async () => {
  const b = await reader(2);
  b.dispatch('pagesinit'); b.app.isInitialViewSet = true; b.app.page = 2;
  b.resize(() => { b.app.page = 1; });
  b.input('pointerdown', { target: { closest: selector => selector.includes('#next') ? {} : null } }); b.app.page = 3;
  b.flushFrames();
  assert.equal(b.app.page, 3);
  assert.equal(b.messages.at(-1).page, 3);
});

test('Given two resize events precede a frame, When layout settles, Then restoration keeps the original page rather than an intermediate one', async () => {
  const b = await reader(2);
  b.dispatch('pagesinit'); b.app.isInitialViewSet = true; b.app.page = 2;
  b.resize(() => { b.app.page = 1; });
  b.resize(() => { b.app.page = 1; });
  b.flushFrames();
  assert.equal(b.app.page, 2);
});

test('Given resize restoration belongs to an old PDF, When another document replaces it, Then the delayed callback leaves the new document alone', async () => {
  const b = await reader(2);
  b.dispatch('pagesinit'); b.app.isInitialViewSet = true; b.app.page = 2;
  b.resize(() => { b.app.page = 1; });
  b.app.pdfDocument = { numPages: 10 }; b.app.page = 4;
  b.flushFrames();
  assert.equal(b.app.page, 4);
});

test('Given a reader is midway through page two, When resize leaves that page selected, Then restoration does not jump to its start', async () => {
  const b = await reader(2);
  b.app.isInitialViewSet = true; b.app.page = 2;
  b.app.pdfViewer.container.scrollTop = 1550;
  b.resize(() => {}); b.flushFrames();
  assert.equal(b.app.page, 2);
  assert.equal(b.app.pdfViewer.container.scrollTop, 1550, 'an unchanged page needs no scroll reset');
});

test('Given resize temporarily selects another page, When correction runs at a new scale, Then it restores the original within-page PDF point', async () => {
  const b = await reader(2);
  b.app.isInitialViewSet = true; b.app.page = 2;
  b.app.pdfViewer.container.scrollTop = 1550;
  b.resize(() => { b.scale(2); b.app.page = 1; }); b.flushFrames();
  assert.equal(b.app.page, 2);
  assert.equal(b.app.pdfViewer.container.scrollTop, 3100, '450 old pixels become 900 at the new scale');
});

for (const [type, event] of [
  ['keydown', { key: 'Shift' }],
  ['pointerdown', { target: { closest: () => null } }],
  ['wheel', { deltaX: 0, deltaY: 0 }],
]) {
  test(`Given resize has a transient page one, When non-navigation ${type} occurs, Then page two remains remembered`, async () => {
    const b = await reader(2);
    b.app.isInitialViewSet = true; b.app.page = 2;
    const before = b.messages.length;
    b.resize(() => { b.app.page = 1; }); b.input(type, event); b.flushFrames();
    assert.equal(b.app.page, 2);
    assert.equal(b.messages.slice(before).some(m => m.page === 1), false, 'non-navigation must not publish the layout artifact');
    assert.equal(b.messages.at(-1).page, 2);
  });
}


for (const [name, type, event, navigate] of [
  ['keyboard Next click', 'click', { detail: 0, target: { closest: selector => selector.includes('#next') ? {} : null } }, b => b.app.pdfViewer.nextPage()],
  ['keyboard Last Page click', 'click', { detail: 0, target: { closest: selector => selector.includes('#lastPage') ? {} : null } }, b => { b.app.page = b.app.pdfDocument.numPages; }],
  ['find-field Enter', 'keydown', { key: 'Enter', target: { closest: selector => selector.includes('#findInput') || selector.includes('input,textarea') ? {} : null } }, b => { b.app.page = 3; }],
  ['Ctrl+G find-again', 'keydown', { key: 'g', ctrlKey: true }, b => { b.app.page = 3; }],
  ['Cmd+Shift+G find-previous', 'keydown', { key: 'G', metaKey: true, shiftKey: true }, b => { b.app.page = 3; }],
]) {
  test(`Given resize has queued page-two recovery, When ${name} navigates, Then its page-three result survives the pending frame`, async () => {
    const b = await reader(2);
    b.app.isInitialViewSet = true; b.app.page = 2;
    b.resize(() => { b.app.page = 1; });
    b.input(type, event); navigate(b); b.flushFrames();
    assert.equal(b.app.page, 3, 'navigation must start from the original page and remain authoritative');
    assert.equal(b.messages.at(-1).page, 3);
  });
}


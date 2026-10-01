'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser, samplePDF } = require('./helpers/viewer-browser');

test('Given a PDF remembered on page two, When Reload mounts its tablet reader, Then page two renders and stays remembered', { timeout: 90000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until, open, size } = b;
  const name = 'remembered & reader.pdf';
  fs.writeFileSync(path.join(b.work, name), samplePDF());
  await open(name);
  const app = `$('filePDF').contentWindow.PDFViewerApplication`;
  await until(`${app}?.pdfDocument?.numPages===3 && ${app}.pdfViewer.getPageView(0)?.renderingState===3`, 'initial PDF renders');
  await run(`${app}.page=2`);
  await until(`localStorage.getItem('chattering.place:'+fileWs.path)==='2'`, 'reader page two remembered');
  await size(1024, 1366, true);
  await run(`$('mediaReload').click()`);
  await until(`${app}?.pdfDocument?.numPages===3 && ${app}.pdfViewer.currentPageNumber===2 && ${app}.pdfViewer.getPageView(1)?.renderingState===3`, async () => 'PDF tablet reload: ' + await run(`JSON.stringify({src:$('filePDF')?.src,page:${app}?.page,pages:${app}?.pdfDocument?.numPages,initialViewSet:${app}?.isInitialViewSet,bookmark:${app}?.initialBookmark,scale:${app}?.pdfViewer?.currentScaleValue,remembered:localStorage.getItem('chattering.place:'+fileWs.path),status:$('docStatus')?.textContent,messageHidden:$('mediaMessage')?.hidden})`));
  assert.equal(await run(`localStorage.getItem('chattering.place:'+fileWs.path)`), '2');
  assert.equal(await run(`${app}.pdfViewer.currentScaleValue`), 'page-width', 'restoration retains the embedded reader zoom policy');
  assert.match(await run(`$('docStatus').textContent`), /3 pages/);
  assert.equal(await run(`$('mediaMessage').hidden`), true);
  assert.deepEqual(b.exceptions, []);
});

for (const zoom of ['page-width', '1.5']) {
  test(`Given the PDF reader is midway through page two at ${zoom} zoom, When its viewport resizes, Then the reading point is preserved`, { timeout: 90000 }, async t => {
    const b = await viewerBrowser(t);
    const { evaluate: run, until, open, size } = b;
    fs.writeFileSync(path.join(b.work, 'mid-page.pdf'), samplePDF());
    await open('mid-page.pdf');
    const app = `$('filePDF').contentWindow.PDFViewerApplication`;
    await until(`${app}?.isInitialViewSet && ${app}.pdfViewer.getPageView(0)?.renderingState===3`, 'initial PDF layout');
    await run(`${app}.pdfViewer.currentScaleValue=${JSON.stringify(zoom)};${app}.page=2;${app}.pdfViewer.container.scrollTop+=200`);
    await until(`${app}.page===2 && ${app}.pdfViewer.getPageView(1)?.renderingState===3`, 'page two at chosen zoom');
    const point = `(()=>{const v=${app}.pdfViewer,p=v.getPageView(1),d=p.div;return p.getPagePoint(v.container.scrollLeft-d.offsetLeft-d.clientLeft,v.container.scrollTop-d.offsetTop-d.clientTop)})()`;
    const before = await run(point);
    // Height-only resizing needs no page correction and must not reset its
    // viewport. Wait for rendering frames, not an arbitrary wall-clock sleep.
    await size(1440, 1100);
    await run(`new Promise(resolve=>$('filePDF').contentWindow.requestAnimationFrame(()=>$('filePDF').contentWindow.requestAnimationFrame(resolve)))`);
    assert.equal(await run(`${app}.page`), 2);
    const afterHeight = await run(point);
    assert.ok(Math.abs(afterHeight[1] - before[1]) < 2, `height-only resize lost within-page point: ${before[1]} → ${afterHeight[1]}`);
    // Changing width also exercises the responsive scale/correction path.
    await size(1024, 1366, true);
    await run(`new Promise(resolve=>$('filePDF').contentWindow.requestAnimationFrame(()=>$('filePDF').contentWindow.requestAnimationFrame(resolve)))`);
    await until(`${app}.page===2 && ${app}.pdfViewer.getPageView(1)?.renderingState===3`, 'same page rendered after width change');
    const afterWidth = await run(point);
    assert.ok(Math.abs(afterWidth[1] - before[1]) < 2, `width resize lost within-page point: ${before[1]} → ${afterWidth[1]}`);
    assert.equal(await run(`localStorage.getItem('chattering.place:'+fileWs.path)`), '2');
    assert.deepEqual(b.exceptions, []);
  });
}

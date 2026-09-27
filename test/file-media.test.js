'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { byteRange, mediaKind, mediaType, serveFile, PreviewAssets } = require('../file-media');

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const abs = path.join(dir, 'picture & résumé.pdf');
  await fs.writeFile(abs, '0123456789');
  return { dir, abs, stat: await fs.stat(abs) };
}
test('media types are explicit, case-insensitive and never expose arbitrary active files', () => {
  for (const [ext, kind] of [['JPEG', 'image'], ['avif', 'image'], ['ico', 'image'], ['MP4', 'video'], ['mov', 'video'], ['webm', 'video'], ['PDF', 'pdf']]) assert.equal(mediaKind('/tmp/x.' + ext), kind);
  for (const ext of ['html', 'svg', 'js', 'exe', 'txt']) assert.equal(mediaType('/tmp/x.' + ext), null);
});
test('single byte ranges: open, closed, suffix, clipped, empty and invalid', () => {
  assert.deepEqual(byteRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(byteRange('bytes=2-', 10), { start: 2, end: 9 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=-30', 10), { start: 0, end: 9 });
  assert.deepEqual(byteRange('bytes=0-99', 10), { start: 0, end: 9 });
  for (const range of ['bytes=10-', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=one-two', 'bytes=99999999999999999999-']) assert.equal(byteRange(range, 10), false, range);
  assert.equal(byteRange('bytes=0-', 0), false);
  for (const range of ['', undefined, 'items=0-4', 'bytes=0-1,3-4']) assert.equal(byteRange(range, 10), null);
});
test('real HTTP: HEAD, seeking, cache validation, download names and stale If-Range', async t => {
  const found = await fixture(t);
  const server = http.createServer(async (req, res) => {
    try { await serveFile(req, res, { ...found, stat: await fs.stat(found.abs) }, 'application/pdf', { download: req.url === '/download' }); }
    catch (error) { res.writeHead(400); res.end(error.message); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=2-4' } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const tag = head.headers.get('etag');
  const part = await fetch(url, { headers: { Range: 'bytes=2-4', 'If-Range': tag } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-4/10'); assert.equal(await part.text(), '234');
  const suffix = await fetch(url, { headers: { Range: 'bytes=-2' } }); assert.equal(await suffix.text(), '89');
  const bad = await fetch(url, { headers: { Range: 'bytes=100-' } }); assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), 'bytes */10');
  assert.equal((await fetch(url, { headers: { 'If-None-Match': 'W/' + tag } })).status, 304);
  for (const validator of ['"stale"', 'W/' + tag, 'Thu, 01 Jan 1970 00:00:00 GMT']) {
    const stale = await fetch(url, { headers: { Range: 'bytes=2-4', 'If-Range': validator } }); assert.equal(stale.status, 200); assert.equal(await stale.text(), '0123456789');
  }
  const download = await fetch(url + '/download');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''picture%20%26%20r%C3%A9sum%C3%A9.pdf/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  await fs.writeFile(found.abs, 'changed');
  const changed = await fetch(url, { headers: { Range: 'bytes=0-2', 'If-Range': tag } });
  assert.equal(changed.status, 200); assert.equal(await changed.text(), 'changed');
});
test('file identity and size are checked again after opening', async t => {
  const found = await fixture(t);
  await fs.rename(found.abs, found.abs + '.old'); await fs.writeFile(found.abs, 'replacement');
  const response = { headersSent: false };
  await assert.rejects(serveFile({ headers: {} }, response, found, 'application/pdf'), /changed while opening/);
  await assert.rejects(serveFile({ headers: {} }, response, { ...found, stat: await fs.stat(found.abs) }, 'application/pdf', { maxBytes: 2 }), /too large/);
});
test('preview grants constrain type, traversal, symlinks, expiry, capacity and revocation', async t => {
  const { dir } = await fixture(t);
  const root = path.join(dir, 'site'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Hello</h1>');
  await fs.writeFile(path.join(root, 'site.css'), 'body{color:red}');
  await fs.writeFile(path.join(root, 'secret.js'), 'secret');
  await fs.writeFile(path.join(dir, 'outside.css'), 'outside');
  await fs.symlink(path.join(dir, 'outside.css'), path.join(root, 'escape.css'));
  let now = 0; const grants = new PreviewAssets({ now: () => now, ttl: 100, limit: 1 });
  const grant = grants.create({ abs: path.join(root, 'index.html') });
  assert.match(grant.token, /^[a-f0-9]{64}$/);
  assert.equal((await grants.resolve(grant.token, 'site.css')).mime, 'text/css; charset=utf-8');
  for (const file of ['../outside.css', 'escape.css', 'secret.js', 'index.html', '/etc/passwd', 'a\\b.css', '\0.css']) await assert.rejects(grants.resolve(grant.token, file));
  assert.throws(() => grants.create({ abs: path.join(root, 'second.html') }), /Too many/);
  now = 101; await assert.rejects(grants.resolve(grant.token, 'site.css'), /expired/);
  const next = grants.create({ abs: path.join(root, 'index.html') }); grants.revoke(next.token);
  await assert.rejects(grants.resolve(next.token, 'site.css'), /expired/);
  assert.throws(() => grants.create({ abs: path.join(root, 'index.js') }), /Only HTML/);
});

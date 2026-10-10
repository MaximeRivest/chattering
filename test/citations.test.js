'use strict';
// Numbered citations (citations.js) and their lookups (papers.js): the
// reference lines agents write, the buttons mdRender makes of [n] markers,
// and the four honest answers a lookup can give.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Citations = require('../citations.js');
globalThis.Citations = Citations;
const { createPapers, parseRef, plainText } = require('../papers.js');

// mdRender, out of app.html, with the same stubs as mdrender.test.js.
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('function mdRender');
const end = html.indexOf('function noteViewer');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const termRegex = q => new RegExp(q.trim().split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
const fenceLang = s => (s.split(/\s+/)[0] || 'txt');
const highlightCodeLine = l => esc(l);
const relPathCandidate = () => '';
// eslint-disable-next-line no-eval
const mdRender = eval('(' + html.slice(start, end).replace(/^function mdRender/, 'function') + ')');

const chipsOf = h => [...h.matchAll(/<button type="button" class="cite" data-cite="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
  .map(m => ({ map: JSON.parse(m[1].replace(/&quot;/g, '"')), label: m[2] }));

test('the asked-for format: one reference per line, DOI link, short label', () => {
  const d = Citations.parseDefLine('- [38] https://doi.org/10.1056/nejmoa2032183 — Wilding 2021, NEJM');
  assert.deepStrictEqual(d, [{ n: 38, ids: ['10.1056/nejmoa2032183'], label: 'Wilding 2021, NEJM' }]);
});

test('older forms: several on a line, several papers per number, footnotes, links', () => {
  const d = Citations.parseDefLine('[14] 10.1038/ijo.2015.177 [15] 10.1002/oby.21167, 10.1038/oby.2009.235 [16] 10.1002/oby.21346');
  assert.deepStrictEqual(d.map(x => [x.n, x.ids]), [[14, ['10.1038/ijo.2015.177']], [15, ['10.1002/oby.21167', '10.1038/oby.2009.235']], [16, ['10.1002/oby.21346']]]);
  assert.deepStrictEqual(Citations.parseDefLine('[^3]: doi:10.5555/abc.')[0].ids, ['10.5555/abc']);
  const l = Citations.parseDefLine('1. [2] [Hall 2019](https://doi.org/10.1016/j.cmet.2019.05.008)')[0];
  assert.deepStrictEqual([l.n, l.ids, l.label], [2, ['10.1016/j.cmet.2019.05.008'], 'Hall 2019']);
  assert.deepStrictEqual(Citations.parseDefLine('[4] https://openalex.org/W3127371223 and PMC1234567')[0].ids, ['W3127371223', 'PMC1234567']);
});

test('a DOI keeps its own brackets and loses the sentence around it', () => {
  assert.deepStrictEqual(Citations.findIds('(see 10.1016/S0140-6736(20)30183-5).'), ['10.1016/S0140-6736(20)30183-5']);
  assert.deepStrictEqual(Citations.findIds('https://doi.org/10.5555/x;'), ['10.5555/x']);
});

test('lines that are not references stay text', () => {
  assert.strictEqual(Citations.parseDefLine('[1] no identifier here'), null);
  assert.strictEqual(Citations.parseDefLine('See [1] 10.5555/abc'), null);
  assert.strictEqual(Citations.parseDefLine('- [ ] 10.5555/abc'), null);
});

const answer = [
  'Higher protein helps a little [6], and so does sleep [30][31].',
  'Ranges work [6–8] and lists [6, 30]. Unknown [99] and `arr[6]` stay.',
  '',
  '## References',
  '- [6] https://doi.org/10.1093/cdn/nzab053_095 — Smith 2021',
  '',
  '- [7] 10.5555/seven',
  '- [8] 10.5555/eight',
  '- [30] 10.1001/jamainternmed.2021.8098',
  '- [31] 10.1186/s12966-015-0267-4',
  '',
  'After the list.',
].join('\n');

test('mdRender: markers become buttons, the list becomes the reference list', () => {
  const h = mdRender(answer);
  const chips = chipsOf(h);
  assert.deepStrictEqual(chips.map(c => c.label), ['6', '30, 31', '6–8', '6, 30']);
  assert.deepStrictEqual(chips[1].map, [[30, ['10.1001/jamainternmed.2021.8098']], [31, ['10.1186/s12966-015-0267-4']]]);
  assert.ok(h.includes('Unknown [99]'), 'a number the list does not define stays text');
  assert.match(h, /<span class="cite-nb">little&nbsp;<button[^>]*>6<\/button>,<\/span>/, 'word, number and comma make one piece');
  assert.ok(h.includes('<code>arr[6]</code>'), 'code is never touched');
  const lists = h.match(/<ol class="cite-refs">/g) || [];
  assert.strictEqual(lists.length, 1, 'blank lines between references keep one list');
  assert.strictEqual((h.match(/<li class="cite-ref" /g) || []).length, 5);
  assert.match(h, /data-cite-n="6" data-cite-ids="10\.1093\/cdn\/nzab053_095"/);
  assert.match(h, /<div class="cite-ref-label">Smith 2021<\/div>/);
  assert.match(h, /<\/ol>\s*<p>After the list\.<\/p>/);
});

test('mdRender: a message without a reference list is untouched', () => {
  const h = mdRender('Item [1] of the array, and [2].');
  assert.ok(!h.includes('class="cite"'));
  assert.ok(h.includes('Item [1] of the array, and [2].'));
});

test('mdRender: references inside a code fence define nothing', () => {
  const h = mdRender('Text [1].\n\n```\n[1] 10.5555/abc\n```');
  assert.ok(!h.includes('class="cite"'));
});

test('mdRender: DOI links carry their id for the hover card', () => {
  const h = mdRender('See [the trial](https://doi.org/10.1056/nejmoa2032183) or https://openalex.org/W3127371223.');
  assert.match(h, /<a href="https:\/\/doi\.org\/10\.1056\/nejmoa2032183" target="_blank" rel="noopener" class="paper-link" data-cite-ids="10\.1056\/nejmoa2032183">the trial<\/a>/);
  assert.match(h, /class="paper-link" data-cite-ids="W3127371223">https:\/\/openalex\.org\/W3127371223<\/a>\./);
});

// ---- papers.js ----

test('parseRef normalizes every identifier form', () => {
  assert.strictEqual(parseRef('https://doi.org/10.1056/NEJMoa2032183').key, 'doi:10.1056/nejmoa2032183');
  assert.strictEqual(parseRef('doi: 10.5555/x').value, '10.5555/x');
  assert.strictEqual(parseRef('https://openalex.org/W123456').key, 'W123456');
  assert.strictEqual(parseRef('pmc1234567').key, 'PMC1234567');
  assert.strictEqual(parseRef('hello'), null);
  assert.strictEqual(plainText('<jats:p>Abstract: A <i>b</i> &amp; c</jats:p>'), 'A b & c');
});

function fakeFetch(routes, calls) {
  return async url => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const [status, body] = hit ? hit[1] : [404, { detail: 'not found' }];
    return { status, json: async () => body };
  };
}

test('lookup: database, then registry, then Crossref; each answer honest', async () => {
  const calls = [];
  const fetchImpl = fakeFetch({
    'db/works/10.5555/found': [200, { id: 'W1', doi: '10.5555/found', title: 'Found <i>paper</i>', year: 2020, authors: 'A One | B Two', authors_count: 2, citations: 7, is_oa: 1, smr: 1, abstract: '<p>Words.</p>' }],
    'doi.org/api/handles/10.5555/fake': [404, { responseCode: 100 }],
    'doi.org/api/handles/10.5555/crossref': [200, { responseCode: 1 }],
    'api.crossref.org/works/10.5555/crossref': [200, { message: { title: ['RETRACTED: Old claim'], author: [{ given: 'A', family: 'Wake' }], 'container-title': ['The Lancet'], published: { 'date-parts': [[1998, 2]] }, type: 'journal-article' } }],
    'doi.org/api/handles/10.5555/datacite': [200, { responseCode: 1 }],
    'db/works/10.5555/down': [503, {}],
  }, calls);
  const p = createPapers({ base: 'http://db', fetchImpl });
  const { papers } = await p.lookup(['10.5555/found', 'https://doi.org/10.5555/fake', '10.5555/crossref', '10.5555/datacite', '10.5555/down', 'nonsense', 'W99999']);
  assert.strictEqual(papers['10.5555/found'].status, 'found');
  assert.strictEqual(papers['10.5555/found'].title, 'Found paper');
  assert.deepStrictEqual(papers['10.5555/found'].authors, ['A One', 'B Two']);
  assert.strictEqual(papers['10.5555/found'].abstract, 'Words.');
  assert.strictEqual(papers['https://doi.org/10.5555/fake'].status, 'missing');
  assert.strictEqual(papers['10.5555/crossref'].status, 'found');
  assert.strictEqual(papers['10.5555/crossref'].source, 'crossref');
  assert.strictEqual(papers['10.5555/crossref'].retracted, true);
  assert.strictEqual(papers['10.5555/crossref'].title, 'Old claim');
  assert.strictEqual(papers['10.5555/crossref'].year, 1998);
  assert.strictEqual(papers['10.5555/datacite'].status, 'registered');
  assert.ok(!papers['10.5555/datacite'].incomplete, 'Crossref said 404: nothing more to ask');
  assert.strictEqual(papers['10.5555/down'].status, 'error');
  assert.strictEqual(papers.nonsense.status, 'invalid');
  assert.strictEqual(papers.W99999.status, 'missing');
  assert.ok(!calls.some(u => u.includes('crossref') && u.includes('fake')), 'a made-up DOI never costs a Crossref request');
});

test('lookup: answers are kept on disk, errors are not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papers-'));
  const cacheFile = path.join(dir, 'papers.json');
  let calls = [];
  let routes = { 'db/works/10.5555/a': [200, { id: 'W1', title: 'A' }], 'db/works/10.5555/b': [500, {}] };
  const p1 = createPapers({ base: 'http://db', cacheFile, fetchImpl: fakeFetch(routes, calls) });
  await p1.lookup(['10.5555/a', '10.5555/b']);
  await new Promise(r => setTimeout(r, 2200));
  assert.ok(fs.existsSync(cacheFile));
  calls = [];
  routes = { 'db/works/10.5555/b': [200, { id: 'W2', title: 'B' }] };
  const p2 = createPapers({ base: 'http://db', cacheFile, fetchImpl: fakeFetch(routes, calls) });
  const { papers } = await p2.lookup(['10.5555/a', '10.5555/b']);
  assert.strictEqual(papers['10.5555/a'].title, 'A');
  assert.strictEqual(papers['10.5555/b'].title, 'B');
  assert.deepStrictEqual(calls, ['http://db/works/10.5555/b'], 'only the failed one is asked again');
  fs.rmSync(dir, { recursive: true, force: true });
});

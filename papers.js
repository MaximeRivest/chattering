'use strict';
// papers.js — what a cited paper is, for the citation cards in a transcript
// (design/97-citations.md).
//
// The page sends the identifiers an answer cites (DOI, OpenAlex W-number,
// PMCID); this module answers one small record per identifier, from:
//   1. the Scholars Reading List API (/works/{ref}): ~200 M papers, with
//      abstract, citation count, open access, ScienceMadeReadable flag;
//   2. for a DOI that API does not hold, the DOI registry (doi.org handles
//      API), which says whether the DOI exists at all;
//   3. for a real DOI, Crossref (/works/{doi}): title, authors, journal,
//      year, retraction notices, for most journal DOIs (DataCite ones —
//      OSF, Zenodo, arXiv — have none there).
// So a card can say four honest things: here is the paper (found), the DOI
// is real but we have no details (registered), no such DOI exists or no
// such paper is in the database (missing), or we could not check (error).
// The registry is asked before Crossref, so a made-up DOI never costs a
// Crossref request; Crossref is asked one request at a time.
// "missing" for a DOI is the registry's own answer: a mistyped or made-up
// reference, which is what a reader most needs to see.
//
// Answers are kept on disk (found 30 days, registered 7, missing 1); errors
// are never kept. One lookup asks at most CONCURRENCY services at a time,
// and the same identifier asked twice at once is fetched once.

const fs = require('fs');
const path = require('path');

const PUBLIC_BASE = 'https://api.sciencemadereadable.com/api/data';
const DAY = 24 * 3600 * 1000;
const KEEP_MS = { found: 30 * DAY, registered: 7 * DAY, missing: DAY };
const INCOMPLETE_KEEP_MS = 3600 * 1000;
const CROSSREF_GAP_MS = 250;
const MAX_REFS = 100;
const MAX_CACHE = 20000;
const CONCURRENCY = 6;
const TIMEOUT_MS = 12000;
const ABSTRACT_MAX = 1500;
const AUTHORS_MAX = 12;
const USER_AGENT = 'Chattering citation cards (https://github.com/rockfrog/chattering)';

// One identifier, normalized. A DOI keeps its case-insensitive identity in
// lower case (DOIs are case-insensitive by definition); the key is what the
// cache and the answer are indexed by.
function parseRef(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch {}
  let m;
  if ((m = s.match(/^(?:https?:\/\/)?(?:www\.)?openalex\.org\/(?:works\/)?(W\d+)$/i)) || (m = s.match(/^(W\d{4,})$/i))) {
    const w = 'W' + m[1].slice(1);
    return { kind: 'openalex', key: w, value: w };
  }
  if ((m = s.match(/^(?:https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/)?(PMC\d{4,})\/?$/i))) {
    const p = m[1].toUpperCase();
    return { kind: 'pmcid', key: p, value: p };
  }
  s = s.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (/^10\.\d{4,9}\/\S+$/.test(s)) {
    const doi = s.toLowerCase();
    return { kind: 'doi', key: 'doi:' + doi, value: doi };
  }
  return null;
}

// A path segment for the APIs: a DOI keeps its slashes (both services take
// /works/10.x/y), every other reserved character is encoded.
const doiPath = doi => doi.split('/').map(encodeURIComponent).join('/');

const decodeEntities = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
// Abstracts arrive with HTML or JATS tags; a card shows plain words.
function plainText(s, max) {
  let t = decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:abstract|summary)[\s.:]+/i, '');
  if (max && t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
    t = cut.slice(0, end > max * 0.6 ? end + 1 : max).trim() + ' …';
  }
  return t;
}

function fromScholars(r) {
  const authors = String(r.authors || '').split(' | ').map(a => a.trim()).filter(Boolean).slice(0, AUTHORS_MAX);
  return {
    status: 'found', source: 'scholars',
    id: r.id || null, doi: r.doi || null, pmcid: r.pmcid || null, openalex: r.openalex || (r.id ? 'https://openalex.org/' + r.id : null),
    title: plainText(r.title) || null, year: r.year || null, date: r.date || null, type: r.type || null,
    authors, authorsCount: r.authors_count || authors.length,
    venue: r.venue || null, publisher: r.publisher || null,
    citations: Number.isFinite(r.citations) ? r.citations : null,
    oa: !!r.is_oa, oaStatus: r.oa_status || null, license: r.license || null,
    url: r.url || (r.doi ? 'https://doi.org/' + r.doi : null), pdfUrl: r.pdf_url || null,
    smr: !!r.smr, retracted: !!r.is_retracted,
    abstract: plainText(r.abstract, ABSTRACT_MAX) || null,
  };
}

const CROSSREF_TYPES = {
  'journal-article': 'article', 'posted-content': 'preprint', 'proceedings-article': 'conference-paper',
  'book-chapter': 'book-chapter', 'book': 'book', 'monograph': 'book', 'edited-book': 'book',
  'dissertation': 'dissertation', 'report': 'report', 'dataset': 'dataset', 'peer-review': 'peer-review',
};
function fromCrossref(m, doi) {
  const title = plainText((m.title || [])[0]);
  const authors = (m.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
  const parts = ((m.published || m.issued || m['published-print'] || m['published-online'] || {})['date-parts'] || [])[0] || [];
  // Retracted: the publisher's title prefix, a Crossmark retraction notice,
  // or a declared is-retracted-by relation.
  const retracted = /^retracted\b/i.test(title)
    || (m['updated-by'] || []).some(u => /retract/i.test(u.type || ''))
    || ((m.relation && m.relation['is-retracted-by']) || []).length > 0;
  return {
    status: 'found', source: 'crossref',
    id: null, doi, pmcid: null, openalex: null,
    title: title.replace(/^retracted:\s*/i, '') || null,
    year: parts[0] || null, date: parts[0] ? parts.map(n => String(n).padStart(2, '0')).join('-') : null,
    type: CROSSREF_TYPES[m.type] || m.type || null,
    authors: authors.slice(0, AUTHORS_MAX), authorsCount: authors.length,
    venue: (m['container-title'] || [])[0] || null, publisher: m.publisher || null,
    citations: Number.isFinite(m['is-referenced-by-count']) ? m['is-referenced-by-count'] : null,
    oa: false, oaStatus: null, license: null,
    url: 'https://doi.org/' + doi, pdfUrl: null, smr: false, retracted,
    abstract: plainText(m.abstract, ABSTRACT_MAX) || null,
  };
}

// What a card needs when there is no paper record: the identifier, and links
// that still lead somewhere.
function bare(ref, status, extra = {}) {
  return {
    status, source: extra.source || null,
    id: ref.kind === 'openalex' ? ref.value : null,
    doi: ref.kind === 'doi' ? ref.value : null,
    pmcid: ref.kind === 'pmcid' ? ref.value : null,
    openalex: ref.kind === 'openalex' ? 'https://openalex.org/' + ref.value : null,
    url: ref.kind === 'doi' ? 'https://doi.org/' + ref.value
      : ref.kind === 'pmcid' ? 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + ref.value + '/'
      : 'https://openalex.org/' + ref.value,
    ...extra,
  };
}

function createPapers({ cacheFile = null, base, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
  const apiBase = String(base || process.env.CHATTERING_PAPERS_API || PUBLIC_BASE).replace(/\/+$/, '');
  let cache = null; // key -> { rec, t }
  let saveTimer = null;
  const inflight = new Map();

  function loadCache() {
    if (cache) return cache;
    cache = new Map();
    if (!cacheFile) return cache;
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      for (const [k, v] of Object.entries(data.entries || {})) if (v && v.rec && v.t) cache.set(k, v);
    } catch {}
    return cache;
  }
  function saveSoon() {
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        // Oldest first out when the cache is full.
        const entries = [...cache.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, MAX_CACHE);
        cache = new Map(entries);
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const tmp = cacheFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(entries) }));
        fs.renameSync(tmp, cacheFile);
      } catch (e) { log('papers cache: ' + e.message); }
    }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: ctl.signal });
      let body = null;
      try { body = await res.json(); } catch {}
      return { status: res.status, body };
    } finally { clearTimeout(timer); }
  }

  async function fetchOne(ref) {
    const target = ref.kind === 'doi' ? doiPath(ref.value) : encodeURIComponent(ref.value);
    const s = await getJson(`${apiBase}/works/${target}`);
    if (s.status === 200 && s.body && (s.body.id || s.body.title)) return fromScholars(s.body);
    if (s.status !== 404) throw new Error(`paper database answered ${s.status}`);
    if (ref.kind !== 'doi') return bare(ref, 'missing', { source: 'scholars' });
    // The registry first: it is fast and generous, and a made-up DOI then
    // never costs a Crossref request. responseCode 1 = the DOI exists;
    // 100 = no such handle; 200 = the handle exists without a URL.
    const h = await getJson(`https://doi.org/api/handles/${doiPath(ref.value)}`);
    const code = h.body && h.body.responseCode;
    if (code === 100) return bare(ref, 'missing', { source: 'doi.org' });
    if (code !== 1 && code !== 200) throw new Error(`doi.org answered ${h.status}`);
    // Real DOI, not in the database: Crossref has the details of most
    // journal DOIs (DataCite ones answer 404). Crossref's public pool takes
    // one request at a time; when it refuses, the card still says the DOI
    // is real, and the details are asked again within the hour.
    const c = await crossrefQueue(() => getJson(`https://api.crossref.org/works/${doiPath(ref.value)}`)).catch(() => ({ status: 0 }));
    if (c.status === 200 && c.body && c.body.message) return fromCrossref(c.body.message, ref.value);
    return bare(ref, 'registered', { source: 'doi.org', ...(c.status === 404 ? {} : { incomplete: true }) });
  }

  // One Crossref request at a time, spaced, across every lookup.
  let crossrefTail = Promise.resolve();
  function crossrefQueue(job) {
    const run = crossrefTail.then(job);
    crossrefTail = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, CROSSREF_GAP_MS)));
    return run;
  }

  function lookupRef(ref) {
    const c = loadCache();
    const hit = c.get(ref.key);
    if (hit && now() - hit.t < (hit.rec.incomplete ? INCOMPLETE_KEEP_MS : (KEEP_MS[hit.rec.status] || 0))) return Promise.resolve(hit.rec);
    if (inflight.has(ref.key)) return inflight.get(ref.key);
    const p = fetchOne(ref).then(rec => {
      c.set(ref.key, { rec, t: now() });
      saveSoon();
      return rec;
    }, e => bare(ref, 'error', { error: e.name === 'AbortError' ? 'timed out' : String(e.message || e) }))
      .finally(() => inflight.delete(ref.key));
    inflight.set(ref.key, p);
    return p;
  }

  // refs: identifiers as the answer wrote them. The result is keyed by the
  // same strings, so the page needs no normalizing of its own.
  async function lookup(refs) {
    const list = [...new Set((refs || []).map(r => String(r).trim()).filter(Boolean))].slice(0, MAX_REFS);
    const out = {};
    const jobs = [];
    for (const raw of list) {
      const ref = parseRef(raw);
      if (!ref) { out[raw] = { status: 'invalid' }; continue; }
      jobs.push({ raw, ref });
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const { raw, ref } = jobs[next++];
        out[raw] = await lookupRef(ref);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    return { papers: out, base: apiBase === PUBLIC_BASE ? 'public' : 'local' };
  }

  return { lookup, parseRef, apiBase };
}

module.exports = { createPapers, parseRef, plainText, PUBLIC_BASE, MAX_REFS };

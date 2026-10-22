'use strict';
// What a written reply sounds like through Kokoro (design/102): the text a
// voice should say, in segments, each with the silence that follows it.
//
// Kokoro reads what it is given, symbols included, and the read-aloud server
// joins its sentences with no gap. So the shape a reader sees (a list, a
// heading, a paragraph) is turned into what a listener needs:
//
// · a list is announced before it starts ("Three things."), unless the line
//   that opens it already says how many, and its items are numbered aloud
//   ("First, … Second, … Third, …"), each followed by a short pause, the
//   list by a longer one;
// · a heading is said as a sentence, then a pause; a paragraph ends in a pause;
// · code, tables, pictures and addresses are on the screen, not read out;
// · markdown marks, emoji and symbols go; a few are said as words.
//
// Pure: no I/O. `toSpeech(markdown)` → [{ text, pauseMs }].
//
// Pauses are silence ADDED to Kokoro's own: its read-aloud server leaves
// about 0.75 s between two sentences at speed 1 (measured 2026-10-17: a
// sentence starts after ~0.26 s and ends with ~0.48 s of silence; 0.6 s heard
// at 1.25×). That gap already carries a list item or a short label, so only a
// paragraph, a heading and the end of a list get a little more. Larger
// pauses, and many short pieces, sounded choppy (heard on the first day).

const PAUSE = { sentence: 0, item: 0, afterList: 300, announce: 0, heading: 150, paragraph: 250, rule: 400 };

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const numberWord = n => NUMBER_WORDS[n] || String(n);
const ordinal = n => ORDINALS[n - 1] || 'number ' + n;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// One line of text as words to say.
function speakInline(raw) {
  let t = String(raw || '');
  t = t.replace(/<[^>]+>/g, ' ');                                   // HTML tags
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                      // pictures
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                    // links: their words
  t = t.replace(/<?https?:\/\/[^\s>)]+>?/g, 'a link on your screen');
  // Inline code: a word or a name is said; a path or an expression is on screen.
  t = t.replace(/`([^`]+)`/g, (m, code) => {
    const c = code.trim();
    if (/[\/\\]/.test(c) && /\w\.\w{1,6}$/.test(c)) return fileName(c);
    if (/[{}()[\];=<>|$\\]|\s{2,}/.test(c) || c.length > 40) return 'the one on your screen';
    return fileName(c);
  });
  t = t.replace(/(^|[\s(])~?\/(?:[\w.@-]+\/)+([\w.@-]+)/g, (m, lead, last) => lead + fileName(last)); // paths: their file's name
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');                        // bold
  t = t.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');    // italic *x*
  t = t.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');       // italic _x_
  t = t.replace(/~~(.+?)~~/g, '$1');
  t = t.replace(/\p{Extended_Pictographic}\uFE0F?/gu, ' ');           // emoji
  t = t.replace(/\s*(?:→|->|⟶)\s*/g, ' to ').replace(/\s*(?:←|<-)\s*/g, ' from ');
  t = t.replace(/(\d)\s*[×x]\s*(?=\d|\b)/g, '$1 times ').replace(/≈\s*/g, 'about ').replace(/~(?=\d)/g, 'about ');
  t = t.replace(/\s&\s/g, ' and ').replace(/\be\.g\.,?/gi, 'for example').replace(/\bi\.e\.,?/gi, 'that is').replace(/\betc\./gi, 'and so on').replace(/\bvs\.?\s/gi, 'versus ');
  t = t.replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, ', ');
  t = t.replace(/[*_#`|>~^\\]+/g, ' ');                              // what is left of the marks
  t = t.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;])(?=\S)/g, '$1 ').replace(/:(?=\p{L})/gu, ': ').replace(/\s{2,}/g, ' ').trim();
  // Kokoro breaks a sentence at "; " and ": " with a whole sentence's gap:
  // inside a sentence they are a comma to the ear ("Topics UX, your layout").
  t = t.replace(/\s*;\s+/g, ', ').replace(/(\D):\s+(?=\S)/g, '$1, ');
  t = t.replace(/^[,;:.\s]+/, '');
  return t;
}
// A file's name as said: "server.js" → "server dot js".
function fileName(name) {
  const base = String(name).split(/[\/\\]/).filter(Boolean).pop() || String(name);
  return base.replace(/\.(?=\w)/g, ' dot ').replace(/[_-]+/g, ' ');
}
const endSentence = s => /[.!?…]["')\]]?$/.test(s) ? s : s.replace(/[,;:]$/, '') + '.';

const LIST_ITEM = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/;
const COUNT_WORDS = new RegExp('\\b(?:' + NUMBER_WORDS.slice(2).join('|') + '|\\d+|both|a few|several|these|the following)\\b', 'i');

// The blocks of a reply: paragraph, heading, list, code, table, rule.
function blocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ kind: 'paragraph', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const fence = line.trim().slice(0, 3);
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith(fence)) i++;
      i++;
      out.push({ kind: 'code' });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) i++;
      out.push({ kind: 'table' });
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ kind: 'heading', text: h[1].replace(/\s+#+\s*$/, '') }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ kind: 'rule' }); continue; }
    const li = LIST_ITEM.exec(line);
    if (li) {
      flush();
      const items = [];
      const top = li[1].length;
      let j = i;
      for (; j < lines.length; j++) {
        const l = lines[j];
        const m = LIST_ITEM.exec(l);
        if (m && m[1].length <= top) items.push([m[2]]);
        else if (m) items[items.length - 1].push(m[2]);                     // a sub-item: part of its item
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) { const it = items[items.length - 1]; it[it.length - 1] += ' ' + l.trim(); } // continued: same sentence
        else if (!l.trim() && j + 1 < lines.length && LIST_ITEM.exec(lines[j + 1]) && LIST_ITEM.exec(lines[j + 1])[1].length <= top + 4) continue; // a loose list
        else break;
      }
      i = j - 1;
      out.push({ kind: 'list', items: items.map(parts => parts.map(p => p.trim()).filter(Boolean)) });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim().replace(/^>\s?/, ''));
  }
  flush();
  return out;
}

// A paragraph's sentences, for a segment each (Kokoro splits there too).
function sentences(text) {
  // A sentence ends at a stop followed by a space: "0.12", "e.g" and "v2.1" stay whole.
  return String(text).split(/(?<=[.!?…]["')\]]*)\s+/).map(s => s.trim()).filter(Boolean);
}

function toSpeech(markdown) {
  const segs = [];
  const say = (text, pauseMs = PAUSE.sentence) => { const t = String(text || '').trim(); if (t && /[\p{L}\p{N}]/u.test(t)) segs.push({ text: t, pauseMs }); };
  const pauseAfterLast = ms => { if (segs.length) segs[segs.length - 1].pauseMs = Math.max(segs[segs.length - 1].pauseMs, ms); };
  const bs = blocks(markdown);
  for (let b = 0; b < bs.length; b++) {
    const block = bs[b];
    if (block.kind === 'paragraph') {
      // A bold label opening a paragraph ("**The ping.** A small checker…")
      // is a heading said aloud: a pause after it.
      const label = /^\s*(\*\*|__)([^*_]{1,80}?[.:!?])\1\s+(?=\S)/.exec(block.text);
      if (label) { say(endSentence(speakInline(label[2])), PAUSE.heading); block.text = block.text.slice(label[0].length); }
      const said = speakInline(block.text);
      const next = bs[b + 1];
      const opensList = next && next.kind === 'list' && /:\s*$/.test(block.text.trim());
      const parts = sentences(said);
      parts.forEach((s, k) => say(k === parts.length - 1 && opensList ? endSentence(s.replace(/:$/, '')) : endSentence(s), k === parts.length - 1 ? (opensList ? PAUSE.announce : PAUSE.paragraph) : PAUSE.sentence));
      if (opensList) next.ledBy = parts[parts.length - 1] || '';
    } else if (block.kind === 'heading') {
      say(endSentence(speakInline(block.text)), PAUSE.heading);
    } else if (block.kind === 'list') {
      const items = block.items.map(parts => parts.map(p => endSentence(speakInline(p))).filter(p => /[\p{L}\p{N}]/u.test(p)).join(' ')).filter(Boolean);
      if (!items.length) continue;
      if (items.length === 1) { say(items[0], PAUSE.paragraph); continue; }
      // "Three things." unless the line before already said how many.
      const lead = block.ledBy || '';
      const counted = lead && (new RegExp('\\b(?:' + numberWord(items.length) + '|' + items.length + ')\\b', 'i').test(lead) || COUNT_WORDS.test(lead) && /\b(?:both|these|the following|several|a few)\b/i.test(lead));
      if (!counted) {
        const last = segs[segs.length - 1];
        // "…first, then:" → "…first, then two things." (said as one sentence)
        if (lead && last && /\b(?:then|also|too|following|follows|include|includes|including|are|is|were|was|like|namely)\.$/i.test(last.text)) last.text = last.text.replace(/\.$/, ' ' + numberWord(items.length) + ' things.');
        else say(cap(numberWord(items.length)) + ' things.', PAUSE.announce);
      }
      items.forEach((item, k) => {
        const n = k + 1;
        const prefix = (n === items.length && items.length > 2 ? 'And ' + ordinal(n) : cap(ordinal(n))) + ', ';
        say(prefix + item, n === items.length ? PAUSE.afterList : PAUSE.item);
      });
    } else if (block.kind === 'code') {
      say('There is some code on your screen.', PAUSE.paragraph);
    } else if (block.kind === 'table') {
      say('There is a table on your screen.', PAUSE.paragraph);
    } else if (block.kind === 'rule') {
      pauseAfterLast(PAUSE.rule);
    }
  }
  if (segs.length) segs[segs.length - 1].pauseMs = 0;
  // Two code blocks in a row are one remark.
  return segs.filter((s, i) => !(i && /on your screen\.$/.test(s.text) && segs[i - 1].text === s.text));
}

// The spoken text, one line per segment (for logs, caches, tests).
const spokenText = segs => segs.map(s => s.text).join('\n');

// Segments in pieces to make one after another: the first sentence alone
// (heard soonest), then pieces of up to `max` characters.
function speechPieces(segs, max = 320) {
  const out = [];
  let cur = [];
  const size = list => list.reduce((n, s) => n + s.text.length + 1, 0);
  for (const s of segs) {
    if (!out.length && !cur.length) { out.push([s]); continue; }
    if (cur.length && size(cur) + s.text.length > max) { out.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

module.exports = { toSpeech, spokenText, speechPieces, speakInline, fileName, PAUSE };

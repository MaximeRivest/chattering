'use strict';
// Measures the prototype against the real, unmodified CLI.
//   node bench.js                 Claude Code: input, editing, paste, menu, dialogs (no model call)
//   node bench.js --live          also one real turn that writes a file (uses your plan)
//   node bench.js --pi            Pi with the generic reader (no model call)
// Writes results/<name>.json and recordings/<name>.cast (asciicast v2).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalHost } = require('./host');
const { readDocument, CLAUDE, GENERIC } = require('./reader');
const { waitFor, choose, pickMenu } = require('./actions');
const { ClaudeJournal } = require('./journal');

const live = process.argv.includes('--live'), pi = process.argv.includes('--pi');
const here = __dirname;
fs.mkdirSync(path.join(here, 'results'), { recursive: true }); fs.mkdirSync(path.join(here, 'recordings'), { recursive: true });
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2) : null; };
const summary = xs => ({ n: xs.length, p50: q(xs, .5), p95: q(xs, .95), max: q(xs, 1) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const name = pi ? 'pi-generic' : live ? 'claude-live' : 'claude-input';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-bench-'));
  const profile = pi ? GENERIC : CLAUDE;
  const command = pi ? 'pi' : 'claude';
  const args = pi ? [] : ['--permission-mode', 'manual', '--effort', 'low'];
  const out = { name, command: [command, ...args].join(' '), when: new Date().toISOString(), cwd, steps: {}, notes: [] };
  const t0 = performance.now();
  const host = new TerminalHost({ command, args, cwd, record: path.join(here, 'recordings', name + '.cast') });
  const journal = pi ? null : new ClaudeJournal(cwd);
  // Every frame: how long the snapshot + reader take.
  const readMs = [], snapMs = [];
  host.on('frame', () => { const a = performance.now(); const s = host.snapshot(); const b = performance.now(); readDocument(s, profile); const c = performance.now(); snapMs.push(b - a); readMs.push(c - b); });
  const doc = () => readDocument(host.snapshot(), profile);
  try {
    // ---- startup, and the folder-trust dialog if it is asked ----
    let d = await waitFor(host, x => x.composer || x.choice, { profile, timeoutMs: 20000 });
    out.steps.firstInteractiveMs = +(performance.now() - t0).toFixed(0);
    if (d.choice) {
      out.steps.trustDialog = { question: d.choice.question.split('\n').slice(0, 3).join(' '), options: d.choice.options.map(o => o.label), selected: d.choice.selected };
      const yes = d.choice.options.findIndex(o => /^yes/i.test(o.label));
      const a = performance.now(); await choose(host, yes, { profile }); out.steps.trustDialog.verifiedChooseMs = +(performance.now() - a).toFixed(0);
      d = await waitFor(host, x => x.composer && !x.choice, { profile, timeoutMs: 15000 });
    }
    await sleep(800);
    d = doc();
    out.steps.composerReadyMs = +(performance.now() - t0).toFixed(0);
    out.steps.idle = { mode: d.mode, placeholder: d.composer && d.composer.placeholder, footer: d.footer.map(f => f.text) };

    // ---- keystroke echo, one key at a time (closed loop) ----
    const sentence = 'The quick brown fox jumps over the lazy dog 0123';
    const firstByte = [], onScreen = [];
    let expect = '';
    for (const ch of sentence) {
      expect += ch;
      const before = performance.now(); host.input(ch, 'k');
      const p = host.pending[host.pending.length - 1];
      await waitFor(host, x => x.composer && x.composer.text === expect.replace(/\s+$/, ''), { profile });
      onScreen.push(performance.now() - before); if (p.firstByteAt) firstByte.push(p.firstByteAt - before);
      await sleep(15);
    }
    out.steps.keystroke = { programFirstByte: summary(firstByte), composerShowsIt: summary(onScreen) };

    // ---- burst typing (a fast typist: 12 ms apart, nothing awaited) ----
    host.input('\x01\x0b'); await waitFor(host, x => x.composer && x.composer.text === '', { profile });
    const burst = 'burst typing keeps every character in order';
    const b0 = performance.now();
    for (const ch of burst) { host.input(ch); await sleep(12); }
    await waitFor(host, x => x.composer && x.composer.text === burst, { profile, timeoutMs: 4000 });
    out.steps.burst = { chars: burst.length, lastKeyToCompleteMs: +(performance.now() - b0 - 12 * burst.length).toFixed(1), allInOrder: doc().composer.text === burst };

    // ---- editing: the program's own editor decides, the page follows ----
    host.input('\x1b[D\x1b[D\x1b[D'); await sleep(150); host.input('X');
    d = await waitFor(host, x => x.composer && x.composer.text.includes('X'), { profile });
    out.steps.editing = { text: d.composer.text, caret: d.composer.caret, expected: 'burst typing keeps every character in orXder', matches: d.composer.text === 'burst typing keeps every character in orXder' };

    // ---- a new line inside the message (Alt+Enter / Shift+Enter → ESC CR) ----
    host.input('\x01\x0b'); await waitFor(host, x => x.composer && x.composer.text === '', { profile });
    host.input('line one'); await sleep(100); host.input('\x1b\r'); await sleep(100); host.input('line two');
    d = await waitFor(host, x => x.composer && /two$/.test(x.composer.text), { profile }).catch(() => doc());
    out.steps.newline = { text: d.composer && d.composer.text, ok: !!(d.composer && d.composer.text === 'line one\nline two'), mode: d.mode };
    host.input('\x1b'); await sleep(200); host.input('\x1b'); await sleep(300); // Esc Esc clears in Claude Code
    d = doc(); if (d.composer && d.composer.text) { host.input('\x01\x0b\x1b[A\x01\x0b'); await sleep(200); }

    // ---- paste (bracketed): short, then large ----
    d = doc(); out.steps.clearedBeforePaste = d.composer && d.composer.text;
    const pa = performance.now(); host.paste('pasted one\npasted two');
    d = await waitFor(host, x => x.composer && /pasted two/.test(x.composer.text), { profile }).catch(() => doc());
    out.steps.pasteShort = { ms: +(performance.now() - pa).toFixed(1), text: d.composer && d.composer.text };
    for (let i = 0; i < 4 && doc().composer && doc().composer.text; i++) { host.input('\x1b'); await sleep(250); host.input('\x1b'); await sleep(250); }
    const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: some pasted content that is long enough`).join('\n');
    const pb = performance.now(); host.paste(big);
    d = await waitFor(host, x => x.composer && x.composer.text.length > 0, { profile, timeoutMs: 4000 }).catch(() => doc());
    await sleep(300); d = doc();
    out.steps.pasteLarge = { chars: big.length, ms: +(performance.now() - pb).toFixed(1), shownAs: d.composer && d.composer.text.slice(0, 120) };
    for (let i = 0; i < 4 && doc().composer && doc().composer.text; i++) { host.input('\x1b'); await sleep(250); host.input('\x1b'); await sleep(250); }

    // ---- the program's own completion menu ----
    if (!pi) {
      const m0 = performance.now(); host.input('/mo');
      d = await waitFor(host, x => x.menu && x.menu.items.length > 1, { profile });
      out.steps.menu = { appearMs: +(performance.now() - m0).toFixed(1), items: d.menu.items.slice(0, 4).map(i => i.label), selected: d.menu.selected };
      const s0 = performance.now(); await pickMenu(host, 1, { profile });
      d = doc(); out.steps.menu.verifiedPickMs = +(performance.now() - s0).toFixed(1); out.steps.menu.composerAfter = d.composer && d.composer.text;
      for (let i = 0; i < 4 && doc().composer && doc().composer.text; i++) { host.input('\x1b'); await sleep(250); host.input('\x1b'); await sleep(250); }
    }

    // ---- one real turn: a tool asks permission, the page answers ----
    if (live && !pi) {
      const timeline = []; let lastSig = '';
      const onFrame = () => {
        const x = doc(); const lastBlock = x.transcript[x.transcript.length - 1];
        const sig = x.mode + '|' + x.transcript.length + '|' + (lastBlock ? lastBlock.text.length : 0) + '|' + (x.status ? x.status.text.slice(0, 20) : '');
        if (sig !== lastSig) { lastSig = sig; timeline.push({ t: +(performance.now() - L0).toFixed(0), mode: x.mode, blocks: x.transcript.length, last: lastBlock ? lastBlock.kind + ':' + lastBlock.text.slice(0, 60) : '', status: x.status && x.status.text }); }
      };
      const prompt = 'Create a file named hello.txt containing exactly the word hi. Then reply with one short sentence.';
      for (const ch of prompt) { host.input(ch); await sleep(4); }
      await waitFor(host, x => x.composer && x.composer.text === prompt, { profile, timeoutMs: 5000 });
      out.steps.livePromptSoftWraps = doc().composer.softWraps;
      const L0 = performance.now(); host.on('frame', onFrame);
      host.input('\r');
      const working = await waitFor(host, x => x.status || x.choice, { profile, timeoutMs: 30000 });
      out.steps.live = { enterToWorkingMs: +(performance.now() - L0).toFixed(0) };
      d = await waitFor(host, x => x.choice, { profile, timeoutMs: 120000 });
      out.steps.live.enterToPermissionMs = +(performance.now() - L0).toFixed(0);
      out.steps.live.permission = { question: d.choice.question, options: d.choice.options.map(o => o.label), selected: d.choice.selected, hint: d.choice.hint && d.choice.hint.text };
      const yes = d.choice.options.findIndex(o => /^yes/i.test(o.label));
      const c0 = performance.now(); await choose(host, yes, { profile, }); out.steps.live.verifiedAllowMs = +(performance.now() - c0).toFixed(0);
      d = await waitFor(host, x => x.composer && !x.status && !x.choice && x.transcript.some(b => b.kind === 'assistant' && !/hello\.txt\)?$/.test(b.text) && b.rows[0] > 0), { profile, timeoutMs: 120000 });
      await sleep(1500); d = doc();
      out.steps.live.enterToDoneMs = +(performance.now() - L0).toFixed(0);
      host.off('frame', onFrame);
      out.steps.live.transcript = d.transcript.filter(b => b.kind !== 'notice').map(b => ({ kind: b.kind, text: b.text.slice(0, 200), result: b.result }));
      out.steps.live.file = fs.existsSync(path.join(cwd, 'hello.txt')) ? fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8') : null;
      await sleep(500);
      out.steps.live.journal = journal.entries.map(e => ({ kind: e.kind, name: e.name, path: e.path, diff: e.diff, text: e.text && e.text.slice(0, 120), error: e.error }));
      out.steps.live.timeline = timeline;
      // How the answer text arrived on screen: distinct growth steps.
      const growth = timeline.filter(x => /^assistant:/.test(x.last));
      out.steps.live.assistantTextUpdates = growth.length;
    }

    out.steps.frames = { count: host.stats.frames, bytesFromProgram: host.stats.bytesOut, snapshotMs: summary(snapMs), readerMs: summary(readMs), parseMsTotal: +host.stats.parseMs.toFixed(1) };
    out.final = (() => { const x = doc(); return { mode: x.mode, composer: x.composer && x.composer.text, live: x.live.length, transcriptKinds: x.transcript.map(b => b.kind) }; })();
  } catch (e) {
    out.error = e.message; out.finalScreen = host.snapshot().lines.slice(-34).map(l => l.text);
  } finally {
    host.kill(); if (journal) journal.close();
    fs.writeFileSync(path.join(here, 'results', name + '.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify(out, (k, v) => k === 'timeline' ? `[${v.length} entries]` : v, 2));
    setTimeout(() => process.exit(out.error ? 1 : 0), 300);
  }
}
main();

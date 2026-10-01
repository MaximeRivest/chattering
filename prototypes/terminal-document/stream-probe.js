'use strict';
// How does a longer answer arrive on Claude Code's screen? One real turn
// (uses your plan); records the answer's visible length over time.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TerminalHost } = require('../../harness/terminal/host'); const { readDocument } = require('../../harness/terminal/reader'); const { waitFor, choose } = require('../../harness/terminal/actions');
(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-stream-'));
  const host = new TerminalHost({ command: 'claude', args: ['--effort', 'low'], cwd, record: path.join(__dirname, 'recordings', 'claude-stream.cast') });
  let d = await waitFor(host, x => x.composer || x.choice, { timeoutMs: 20000 });
  if (d.choice) await choose(host, d.choice.options.findIndex(o => /^yes/i.test(o.label)));
  await waitFor(host, x => x.composer && !x.choice, { timeoutMs: 15000 });
  const prompt = 'Without using any tools, write about 250 words on why terminals redraw the screen. Plain prose, no lists.';
  for (const ch of prompt) { host.input(ch); await new Promise(r => setTimeout(r, 3)); }
  await waitFor(host, x => x.composer && x.composer.text === prompt, { timeoutMs: 5000 });
  const t0 = performance.now(), series = []; let last = -1;
  host.on('frame', () => { const x = readDocument(host.snapshot()); const a = x.transcript.filter(b => b.kind === 'assistant').map(b => b.text).join('\n'); if (a.length !== last) { last = a.length; series.push([Math.round(performance.now() - t0), a.length, x.mode]); } });
  host.input('\r');
  await waitFor(host, x => x.composer && !x.status && x.transcript.some(b => b.kind === 'assistant' && b.text.length > 300), { timeoutMs: 120000 });
  await new Promise(r => setTimeout(r, 1200));
  host.kill();
  const out = { when: new Date().toISOString(), updates: series.length, series };
  fs.writeFileSync(path.join(__dirname, 'results', 'claude-stream.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

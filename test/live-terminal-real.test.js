'use strict';
// The real agents, one message each (opt-in: CHATTERING_REAL_AGENTS=1, or a
// list: =claude,codex). Each installed program is started on a terminal in
// a fresh folder, read with its profile, sent one message through the
// closed loop, and its one-word reply is read on its screen; then it ends.
// Budget: one message per agent, a reply of one word. Uses this account's
// own sign-in to each agent.
//
// Nothing is left changed in the agents' own settings: Claude Code is
// started in manual mode for that run; Codex records a folder it is told to
// trust in its config, which is snapshot first and put back exactly (only
// that folder may differ, else the test fails and says so).
// Run after every agent update, with the replay tests: their screens change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { terminalDeps } = require('../harness/terminal/deps');
const { TerminalHost } = require('../harness/terminal/host');
const { createHub } = require('../harness/terminal/hub');
const { profileFor, fill } = require('../harness/terminal/profiles');
const { choose } = require('../harness/terminal/actions');

const want = String(process.env.CHATTERING_REAL_AGENTS || '');
const wanted = id => want === '1' || want.split(',').includes(id);
const which = bin => { try { return execFileSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).trim(); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const AGENTS = {
  claude: { bin: 'claude', extra: ['--permission-mode', 'default'] },
  pi: { bin: 'pi', extra: [] },
  codex: { bin: 'codex', extra: ['-a', 'on-request', '-s', 'workspace-write'] },
};

for (const [id, a] of Object.entries(AGENTS)) {
  const bin = wanted(id) ? which(a.bin) : null;
  const skip = !wanted(id) ? 'opt-in: CHATTERING_REAL_AGENTS=1 (one small message to the real ' + id + ')' : terminalDeps().error || (!bin && id + ' is not installed');
  test(`the real ${profileFor(id).name}: start, read, one message, its reply, end`, { skip, timeout: 180000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'chattering-real-agent-'));
    const codexConfig = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const before = id === 'codex' && fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, 'utf8') : null;
    const profile = profileFor(id);
    const sessionId = id === 'codex' ? null : (id === 'pi' ? require('../harness/live-terminal').newId('uuidv7') : require('node:crypto').randomUUID());
    const args = [...fill(profile.start, { sessionId }), ...a.extra];
    const host = new TerminalHost({ command: bin, args, cwd: dir, cols: 100, rows: 34, scrollback: 200 });
    const hub = createHub({ host, profile, liveOnly: true });
    t.after(() => {
      hub.close(); host.kill();
      if (before != null) {
        const now = fs.readFileSync(codexConfig, 'utf8');
        if (now !== before) {
          const added = now.split('\n').filter(l => !before.split('\n').includes(l) && l.trim() && l.trim() !== 'trust_level = "trusted"');
          assert.ok(added.every(l => l.includes(dir)), 'Codex changed its config beyond this test\'s folder: ' + JSON.stringify(added));
          fs.writeFileSync(codexConfig, before);
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    // Ready: its box, after its trust question if it asks one.
    const t0 = Date.now();
    let d = await hub.until(x => (x.composer && !x.status) || x.choice, 30000);
    if (d.choice) {
      const yes = d.choice.options.findIndex(o => /^Yes|trust/i.test(o.label));
      assert.ok(yes >= 0, 'a question at start with no yes: ' + JSON.stringify(d.choice));
      await choose(host, yes, { profile });
      d = await hub.until(x => x.composer && !x.status && !x.choice, 30000);
    }
    const startMs = Date.now() - t0;
    const word = 'ok' + Math.random().toString(36).slice(2, 7);
    await hub.submit(`Reply with exactly this one word and nothing else: ${word}`);
    // Its reply on its screen, and the program ready again.
    const t1 = Date.now();
    let seen = false;
    while (Date.now() - t1 < 120000) {
      const lines = host.snapshot({ screenOnly: true }).lines.map(l => l.text).join('\n');
      const doc = hub.state();
      if (lines.split(word).length - 1 >= 2 && doc.mode === 'compose') { seen = true; break; }
      await sleep(250);
    }
    assert.ok(seen, 'its reply on its screen: ' + host.snapshot({ screenOnly: true }).lines.map(l => l.text).filter(Boolean).slice(-12).join('\n'));
    t.diagnostic(`${profile.name}: ready in ${startMs} ms, replied in ${Date.now() - t1} ms`);
  });
}

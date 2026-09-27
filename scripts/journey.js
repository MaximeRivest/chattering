'use strict';
// A stranger's first conversation, through the same HTTP routes the page
// uses (design/73): connect a model server, hear its first words, send a
// first message, and find the reply saved. The model is a local server that
// speaks the OpenAI-compatible protocol, as Ollama or LM Studio would on a
// person's computer. Used by the stranger tests of every download and
// installer (smoke-release.js, smoke-installer.js).
//
//   await firstConversation({ base, token, home, step })
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { fakeOpenAI } = require('../test/helpers/fake-openai.js');

// The command an agent runs in its second conversation, through Pi's own
// bash tool: it leaves a mark, and on Windows a PowerShell reports whether
// its console has a visible window (the flash people see per command).
const WINDOW_PROBE = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'
$h = [W.K]::GetConsoleWindow()
Set-Content -Path $args[0] -Value ([bool]($h -ne [System.IntPtr]::Zero -and [W.K]::IsWindowVisible($h)))`;

async function firstConversation({ base, token, home, step = () => {} }) {
  const work = fs.mkdtempSync(path.join(home, 'agent-work-'));
  const slash = p => p.split(path.sep).join('/'); // Git Bash reads C:/x
  const mark = path.join(work, 'tool-ran.txt'), probe = path.join(work, 'probe.ps1'), seen = path.join(work, 'window.txt');
  if (process.platform === 'win32') fs.writeFileSync(probe, WINDOW_PROBE);
  const powershell = process.platform === 'win32' ? slash(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) : '';
  const command = `echo tool-ran > "${slash(mark)}"` + (process.platform === 'win32' ? ` && "${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${slash(probe)}" "${slash(seen)}"` : '');
  const model = await fakeOpenAI({ models: ['stranger-model'], reply: p => {
    const text = JSON.stringify(p.messages);
    const last = (p.messages || []).at(-1) || {};
    if (last.role === 'tool') return 'The check ran.';
    // The person's words, not the reply-rewrite helper quoting them.
    const said = typeof last.content === 'string' ? last.content : (last.content || []).map(c => c.text || '').join('');
    if (last.role === 'user' && /Run the check\./.test(said) && !/Re-explain/.test(said)) return { tool: { name: 'bash', arguments: { command } } };
    return /ready to help/.test(text) ? 'Hello! I am ready to help.' : 'The tomatoes want the sunny fence.';
  } });
  const call = async (route, body) => {
    const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const out = await r.json().catch(() => ({}));
    assert.ok(r.ok && !out.error, route + ' → ' + r.status + ' ' + JSON.stringify(out).slice(0, 400));
    return out;
  };
  try {
    const before = await call('/api/ai');
    assert.equal(before.ready, false, 'a stranger starts with no AI');
    assert.ok(before.providers.some(p => p.id === 'anthropic' && p.oauth), 'Claude plans are offered');
    const added = await call('/api/ai/server', { baseUrl: model.baseUrl });
    assert.deepEqual(added.default, { provider: added.name, model: 'stranger-model' });
    step('connected a model on this computer (' + added.name + ')');
    const hello = await call('/api/ai/test', {});
    assert.equal(hello.text, 'Hello! I am ready to help.');
    step('the model said hello in ' + hello.ms + ' ms');
    const started = await call('/api/conversation/start-loose', { prompt: 'Where should the tomatoes go?', draftId: 'strangerdraft01' });
    assert.ok(started.key, 'a conversation was started: ' + JSON.stringify(started).slice(0, 200));
    const sessions = path.join(home, '.pi', 'agent', 'sessions');
    let saved = '';
    for (let i = 0; i < 300 && !/sunny fence/.test(saved); i++) {
      await new Promise(r => setTimeout(r, 200));
      saved = '';
      try { for (const f of fs.readdirSync(sessions, { recursive: true })) if (String(f).endsWith('.jsonl')) saved += fs.readFileSync(path.join(sessions, String(f)), 'utf8'); } catch {}
    }
    assert.match(saved, /sunny fence/, 'the reply is saved in the conversation');
    assert.ok(model.requests.some(r => /tomatoes go/.test(JSON.stringify(r.body || ''))), 'the message reached the model');
    step('a first conversation got its reply');
    // An agent at work: a command through its bash tool.
    const agent = await call('/api/conversation/start-loose', { prompt: 'Run the check.', draftId: 'strangerdraft02' });
    const transcript = () => { let t = ''; try { for (const f of fs.readdirSync(sessions, { recursive: true })) if (String(f).endsWith('.jsonl')) { const x = fs.readFileSync(path.join(sessions, String(f)), 'utf8'); if (/Run the check/.test(x)) t = x; } } catch {} return t; };
    // Its turn is over when its last reply is saved (then nothing is running).
    for (let i = 0; i < 450 && !/The check ran/.test(transcript()); i++) await new Promise(r => setTimeout(r, 200));
    const toolSaid = () => model.requests.flatMap(r => (r.body && r.body.messages || []).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    const why = () => '\n--- the command: ' + command + '\n--- what the bash tool answered: ' + (toolSaid().at(-1) || '(nothing)').slice(0, 2000) + '\n--- asked of the model: ' + model.requests.map(r => (r.body && r.body.messages || []).map(m => m.role).join(',')).join(' | ');
    assert.ok(fs.existsSync(mark), 'the agent ran a command with its bash tool' + why());
    assert.match(transcript(), /The check ran/, 'the agent finished its turn' + why());
    if (process.platform === 'win32') {
      for (let i = 0; i < 300 && !fs.existsSync(seen); i++) await new Promise(r => setTimeout(r, 200));
      assert.ok(fs.existsSync(seen), 'the window probe answered' + why());
      assert.equal(fs.readFileSync(seen, 'utf8').trim(), 'False', 'the agent’s command opened no window');
      step('the agent ran a command, and no window opened');
    } else step('the agent ran a command with its bash tool');
  } finally { await model.close(); }
}
module.exports = { firstConversation };

#!/usr/bin/env node
'use strict';
// The stranger test, automated (design/71): an unpacked download, a home
// that has never seen Chattering, no Pi or Node installed as far as it
// knows (PATH holds only the system's folders). Start it with its own
// launcher, find a conversation, search it, read the page, use the records
// command, connect a model and hold a first conversation, stop it. Run by
// CI on every system before a release.
//   node scripts/smoke-release.js dist/chattering-<version>-<os>-<arch>
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');

const app = path.resolve(process.argv[2] || '');
assert.ok(fs.existsSync(path.join(app, 'launcher.js')), 'usage: smoke-release.js <unpacked download>');
const win = process.platform === 'win32';
const node = path.join(app, 'runtime', 'node', win ? 'node.exe' : path.join('bin', 'node'));
const build = JSON.parse(fs.readFileSync(path.join(app, 'BUILD.json'), 'utf8'));
// The rat inside, for notebooks: the one .rat-version pins, new enough.
{
  const rat = path.join(app, 'runtime', 'rat', win ? 'rat.exe' : 'rat');
  assert.ok(fs.existsSync(rat), 'the download carries rat');
  const v = JSON.parse(spawnSync(rat, ['version', '--json'], { encoding: 'utf8', timeout: 30000 }).stdout);
  assert.equal(v.version, build.rat, 'the rat BUILD.json names');
  assert.ok(v.notebook_api >= 2, 'rat answers notebook_api 2');
  assert.ok(fs.existsSync(path.join(app, 'runtime', 'rat', 'LICENSE')), "rat's license ships with it");
}
// Not under the temp folder: conversations there count as loose, not projects.
const home = fs.mkdtempSync(path.join(os.homedir(), '.chattering-stranger-'));
const systemPath = win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(';') : '/usr/bin:/bin:/usr/sbin:/sbin';
// Windows' standard variables, which every program there has (Pi finds Git
// Bash through ProgramFiles); PATH still holds only the system's folders.
const WIN_VARS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'ProgramData', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERNAME', 'COMPUTERNAME', 'OS'];
const env = { ...(win ? Object.fromEntries(WIN_VARS.map(k => [k, process.env[k]])) : {}), TMPDIR: process.env.TMPDIR,
  [win ? 'Path' : 'PATH']: systemPath, LANG: 'en_US.UTF-8',
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  CHATTERING_NO_BROWSER: '1', PORT: String(17433 + Math.floor(Math.random() * 500)) };
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
const run = (args, extra = {}) => spawnSync(node, args, { cwd: home, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
const step = m => console.log('· ' + m);

// A conversation from before, in the Pi folder this home would have.
const cwd = path.join(home, 'Projects', 'garden');
fs.mkdirSync(cwd, { recursive: true });
const sessions = path.join(home, '.pi', 'agent', 'sessions', require(path.join(app, 'runtime.js')).piSessionDirName(cwd));
fs.mkdirSync(sessions, { recursive: true });
const line = o => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(sessions, '2026-09-26T10-00-00-000Z_01a0smoke000000000000000000000000.jsonl'),
  line({ type: 'session', version: 3, id: '01a0smoke000000000000000000000000', timestamp: '2026-09-26T10:00:00.000Z', cwd })
  + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-26T10:00:01.000Z', message: { role: 'user', content: 'plant the tomatoes near the fence' } })
  + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-26T10:00:02.000Z', message: { role: 'assistant', content: 'The fence gets the most sun.', model: 'x' } }));

let ok = false;
(async () => {
  try {
    step('version: ' + run([path.join(app, 'launcher.js'), 'version']).stdout.trim());
    const started = run([path.join(app, 'launcher.js'), 'start']);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    step(started.stdout.trim());
    const url = run([path.join(app, 'launcher.js'), 'url']).stdout.trim();
    const base = new URL(url).origin, token = new URL(url).searchParams.get('token');
    assert.ok(token, 'the launcher knows the install token');
    const get = async p => { const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + token } }); return { status: r.status, text: await r.text() }; };
    const status = JSON.parse((await get('/api/app/status')).text);
    assert.equal(status.version, build.version);
    assert.equal(status.pi, build.pi, 'the Pi that ships, not another');
    assert.equal(status.piSource, 'bundled');
    // A stranger's machine has no rat: notebooks use the one inside
    // (asked in the background at start, so wait for its answer).
    let ratStatus = status.rat;
    for (let i = 0; i < 50 && !(ratStatus && ratStatus.version); i++) {
      await new Promise(r => setTimeout(r, 200));
      ratStatus = JSON.parse((await get('/api/app/status')).text).rat;
    }
    assert.equal(ratStatus && ratStatus.source, 'bundled', 'notebooks run on the rat inside: ' + JSON.stringify(ratStatus));
    assert.equal(ratStatus.version, build.rat);
    assert.equal(path.resolve(status.nodePath), path.resolve(node), 'the Node that ships');
    step(`running ${status.version}, Node ${status.node}, Pi ${status.pi} (${status.piSource})`);
    assert.equal((await fetch(base + '/api/sessions')).status, 401, 'no sign-in, no answer');
    let list = [];
    for (let i = 0; i < 100 && !list.length; i++) { list = JSON.parse((await get('/api/sessions')).text); if (!list.length) await new Promise(r => setTimeout(r, 200)); }
    assert.equal(list.length, 1, 'the existing conversation is found');
    assert.equal(list[0].project, 'garden');
    step('found the conversation in project ' + list[0].project);
    const search = JSON.parse((await get('/api/search?q=tomatoes')).text);
    assert.ok(JSON.stringify(search).includes(list[0].key), 'word search finds it');
    step('word search finds it');
    const page = await fetch(base + '/', { headers: { Cookie: 'chattering=' + token } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>/);
    step('the page loads');
    const records = run([path.join(app, 'chattering'), 'search', 'tomatoes'], { CHATTERING_PORT: new URL(base).port });
    assert.equal(records.status, 0, records.stdout + records.stderr);
    assert.match(records.stdout, /tomatoes|fence/);
    step('the records command answers');
    const models = JSON.parse((await get('/api/models')).text);
    assert.ok(Array.isArray(models.models), 'Pi lists its models (none signed in is fine): ' + JSON.stringify(models).slice(0, 200));
    step('Pi answers (' + models.models.length + ' models listed' + (models.error ? '; ' + models.error.slice(0, 80) : '') + ')');
    // The first minutes: connect a model, its hello, a first reply (design/73).
    await require('./journey.js').firstConversation({ base, token, home, step });
    const stopped = run([path.join(app, 'launcher.js'), 'stop']);
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(run([path.join(app, 'launcher.js'), 'status']).status, 3, 'stopped means stopped');
    step('stopped');
    ok = true;
  } catch (e) {
    console.error(e);
    try { console.error('--- server log ---\n' + fs.readFileSync(path.join(require(path.join(app, 'platform.js')).appDirs(env, home).data, 'logs', 'server.log'), 'utf8').slice(-4000)); } catch {}
    run([path.join(app, 'launcher.js'), 'stop', '--force']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log(ok ? 'The download works for a stranger.' : 'The download FAILED the stranger test.');
    process.exit(ok ? 0 : 1);
  }
})();

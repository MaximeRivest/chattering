'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = process.argv[2];
const app = path.resolve(__dirname, '../..');
const cwd = process.env.WEB_POLICY_PROJECT;
assert.ok(cwd && cwd.startsWith(process.env.HOME + path.sep));
const agent = process.env.PI_CODING_AGENT_DIR;
const provider = path.join(app, 'test/fixtures/web-policy-provider.ts');
// Test-owned contract allows this regression to run on pristine upstream too.
const REQUIRED_EXTENSIONS = ['delegation', 'records', 'modes', 'artifacts', 'image-budget'].map(name => path.join(app, 'extensions', name + '.ts'));
const webExtensionArgs = ({ discovery = 'all', providerExtension } = {}) => [
  ...(discovery === 'minimal' ? ['--no-extensions'] : []), ...REQUIRED_EXTENSIONS.flatMap(file => ['-e', file]),
  ...(providerExtension ? ['-e', providerExtension] : [])];
const { createRuntimeEngine, loadSdk } = require('../../pisdk-runtime.js');
const rpc = require('../../pirpc.js');
function put(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function json(file, value) { put(file, JSON.stringify(value)); }
function log() { try { return fs.readFileSync(process.env.WEB_POLICY_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }
function ambient(file, name) { put(file, `export default pi => { pi.registerCommand('${name}', {handler: async () => {}}); };`); }
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('fixture did not become ready'); }
(async () => {
  assert.deepEqual(Object.keys(process.env).filter(k => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|AWS_|GOOGLE_APPLICATION_CREDENTIALS)/.test(k)), []);
  const { isLooseCwd } = require('../../projectfolds.js');
  assert.equal(isLooseCwd(cwd), false, 'positive checkpoint project is not a general temporary folder');
  assert.equal(isLooseCwd(path.join(process.env.TMPDIR, 'project')), true, 'general temporary folders stay loose');
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('/usr/bin/git', ['init', '--quiet', cwd]);
  put(path.join(cwd, 'widget.html'), '<p>fixture</p>');
  // Context discovery remains normal even outside the source ancestry. These
  // sentinels prove global, ancestor and project context survives both policies.
  const sentinelContexts = [
    { path: path.join(agent, 'AGENTS.md'), content: '# web-policy agent sentinel\nKeep fixture agent context.\n' },
    { path: path.join(path.dirname(cwd), 'AGENTS.md'), content: '# web-policy ancestor sentinel\nKeep fixture ancestor context.\n' },
    { path: path.join(cwd, 'AGENTS.md'), content: '# web-policy project sentinel\nKeep fixture project context.\n' },
  ];
  for (const file of sentinelContexts) put(file.path, file.content);
  const globalExt = path.join(agent, 'extensions/global.ts');
  const projectExt = path.join(cwd, '.pi/extensions/project.ts');
  const settingExt = path.join(root, 'settings-extension.ts');
  const pkg = path.join(root, 'package');
  const packageExt = path.join(pkg, 'extensions/package.ts');
  ambient(globalExt, 'ambient-global'); ambient(projectExt, 'ambient-project');
  ambient(settingExt, 'ambient-settings'); ambient(packageExt, 'ambient-package');
  json(path.join(pkg, 'package.json'), { name: 'offline-policy-package', pi: { extensions: ['extensions'], prompts: ['prompts'], skills: ['skills'], themes: ['themes'] } });
  put(path.join(pkg, 'prompts/package.md'), 'Fixture package prompt');
  put(path.join(pkg, 'skills/package/SKILL.md'), '---\nname: package\ndescription: Fixture package skill\n---\nFixture skill');
  put(path.join(agent, 'prompts/global.md'), 'Fixture global prompt');
  put(path.join(cwd, '.pi/prompts/project.md'), 'Fixture project prompt');
  json(path.join(agent, 'settings.json'), { defaultProvider: 'web-policy-fixture', defaultModel: 'offline', defaultProjectTrust: 'trusted',
    extensions: [settingExt], packages: [pkg], compaction: { enabled: false }, retry: { enabled: false } });
  // Project trust is established only in this isolated fixture, not weakened by production code.
  const loaded = await loadSdk();
  assert.equal(require(path.join(loaded.dir, 'package.json')).version, '0.87.1');
  const { SDK } = loaded;
  const fixtureTheme = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'dist/modes/interactive/theme/light.json'), 'utf8'));
  fixtureTheme.name = 'fixture-theme'; json(path.join(pkg, 'themes/fixture.json'), fixtureTheme);
  const trust = new SDK.ProjectTrustStore(agent);
  trust.set(cwd, true);
  const runtimes = [], events = [], disposals = new Map(), disposedRuntimes = new Set();
  let failedRuntime, recoveryFile;
  // Observe the actual runtime result without replacing any SDK behavior.
  const engine = createRuntimeEngine({ loadSdk: async () => ({ ...loaded, SDK: { ...SDK,
    createAgentSessionRuntime: async (...args) => {
      if (recoveryFile && args[1].sessionManager.getSessionFile() === recoveryFile) {
        assert.ok(disposedRuntimes.has(failedRuntime), 'failed runtime teardown completes before replacement creation');
      }
      const runtime = await SDK.createAgentSessionRuntime(...args); runtimes.push(runtime);
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        disposals.set(runtime, (disposals.get(runtime) || 0) + 1);
        await dispose(); disposedRuntimes.add(runtime);
      };
      return runtime;
    } } }),
    onEvent: (event, state) => { assert.equal(typeof state.sessionPath, 'string'); events.push(event); } });
  const target = discovery => ({ cwd, extraArgs: [...webExtensionArgs({ discovery, providerExtension: provider }), '--append-system-prompt', 'fixture append retained'] });
  let minimal, all, evidence;
  try {
    minimal = await engine.piBeginWarm(target('minimal'));
    const inspect = runtime => {
      const loader = runtime.services.resourceLoader;
      const extensions = loader.getExtensions();
      assert.deepEqual(extensions.errors, []);
      assert.deepEqual(runtime.diagnostics, []);
      return { paths: extensions.extensions.map(e => e.path).sort(),
        prompts: loader.getPrompts().prompts.map(p => p.name).sort(),
        skills: loader.getSkills().skills.map(s => s.name).sort(),
        themes: loader.getThemes().themes.map(t => t.name).sort(),
        context: loader.getAgentsFiles().agentsFiles.map(f => ({ path: f.path, content: f.content })),
        hooks: Object.fromEntries(extensions.extensions.map(e => [e.path, [...e.handlers.keys()].sort()])) };
    };
    const min = inspect(runtimes.at(-1));
    assert.deepEqual(min.paths, [...REQUIRED_EXTENSIONS, provider, '<inline:workspace-checkpoints>'].sort());
    assert.deepEqual(min.prompts, ['global', 'package', 'project']);
    assert.deepEqual(min.skills, ['package']);
    assert.deepEqual(min.themes, ['fixture-theme']);
    assert.deepEqual(min.context.filter(f => sentinelContexts.some(s => s.path === f.path)), sentinelContexts);
    assert.deepEqual(min.hooks[REQUIRED_EXTENSIONS.find(p => p.endsWith('image-budget.ts'))], ['context']);
    assert.deepEqual(min.hooks['<inline:workspace-checkpoints>'], ['agent_settled', 'before_agent_start', 'session_shutdown', 'tool_call', 'tool_result']);
    const tools = runtimes.at(-1).session.getAllTools().map(t => t.name).sort();
    for (const name of ['delegate', 'delegation_status', 'delegation_control', 'delegation_resume', 'delegation_review', 'chattering_search', 'chattering_show', 'chattering_memory', 'chattering_read', 'chattering_list', 'artifact', 'show']) assert.ok(tools.includes(name), name);
    await engine.piHeadlessRun({ ...target('minimal'), sessionPath: minimal.file }, { message: 'fixture-artifacts' }).done;
    assert.ok(log().some(e => e.artifact?.session === minimal.file));
    const entries = SDK.SessionManager.open(minimal.file).getEntries();
    assert.deepEqual(entries.filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => [e.message.toolName, e.message.isError]).sort(), [['artifact', false], ['show', false]]);
    assert.ok(log().find(e => e.request)?.request.systemPrompt.includes('fixture append retained'));
    for (const file of sentinelContexts) assert.ok(log().find(e => e.request).request.systemPrompt.includes(file.content.trim()));
    const { DatabaseSync } = require('node:sqlite');
    const checkpointDb = new DatabaseSync(path.join(process.env.CHATTERING_CHECKPOINT_DIR, 'metadata.sqlite'), { readOnly: true });
    const boundaries = checkpointDb.prepare('SELECT tool,phase,error FROM checkpoint_boundaries WHERE session=? ORDER BY id').all(minimal.file);
    checkpointDb.close();
    assert.deepEqual(boundaries.map(b => [b.tool, b.phase]).sort(), [
      ['', 'run-before'], ['', 'run-settled'], ['artifact', 'before'], ['artifact', 'after'], ['show', 'before'], ['show', 'after'],
    ].sort());
    assert.deepEqual(boundaries.map(b => b.error), Array(6).fill(''));
    // Production context hook drops old images but leaves the saved history untouched.
    const imageSession = SDK.SessionManager.create(cwd, path.join(root, 'sessions'));
    imageSession.appendMessage({ role: 'user', content: [
      { type: 'image', data: 'A'.repeat(9 * 1024 * 1024), mimeType: 'image/png' },
      { type: 'image', data: 'B'.repeat(9 * 1024 * 1024), mimeType: 'image/png' },
    ], timestamp: Date.now() });
    imageSession._rewriteFile(); imageSession.flushed = true;
    await engine.piHeadlessRun({ ...target('minimal'), sessionPath: imageSession.getSessionFile() }, { message: 'fixture-images' }).done;
    const imageRequest = log().filter(e => e.request).at(-1).request;
    const imageContent = imageRequest.messages.find(m => m.role === 'user').content;
    assert.deepEqual(imageContent.filter(b => b.type === 'image').map(b => b.bytes), [9 * 1024 * 1024]);
    assert.ok(imageContent.some(b => b.type === 'text' && b.text.includes('no longer sent')));
    assert.equal(SDK.SessionManager.open(imageSession.getSessionFile()).getEntries()[0].message.content.filter(b => b.type === 'image').length, 2);
    engine.stopWarmSession(imageSession.getSessionFile());
    assert.deepEqual(events.filter(e => e.type === 'extension_error'), []);
    // Policy change while active: keep the current runtime, then retire at next idle operation.
    const activeRuntime = runtimes.find(r => r.session.sessionFile === minimal.file);
    const beforeHeld = runtimes.length;
    const held = engine.piHeadlessRun({ ...target('minimal'), sessionPath: minimal.file }, { message: 'fixture-hold' });
    await until(() => log().some(e => e.holding));
    await engine.piBeginWarm({ ...target('all'), sessionPath: minimal.file });
    assert.equal(runtimes.length, beforeHeld);
    assert.equal(disposals.get(activeRuntime), undefined, 'the actual active minimal runtime is not disposed');
    put(process.env.WEB_POLICY_RELEASE, 'release');
    await held.done;
    const shutdowns = log().filter(e => e.shutdown).length;
    all = await engine.piBeginWarm({ ...target('all'), sessionPath: minimal.file });
    assert.notEqual(runtimes.at(-1), activeRuntime);
    assert.equal(log().filter(e => e.shutdown).length, shutdowns + 1);
    const full = inspect(runtimes.at(-1));
    assert.deepEqual(full.paths, [...min.paths, globalExt, projectExt, settingExt, packageExt].sort());
    assert.deepEqual(full.prompts, min.prompts); assert.deepEqual(full.skills, min.skills); assert.deepEqual(full.themes, min.themes); assert.deepEqual(full.context, min.context);
    // Real SDK dispatcher reports a required hook failure. Its failed runtime
    // must be retired, not reused to execute healthy work and rethrow an old error.
    const recovery = await engine.piBeginWarm(target('minimal'));
    failedRuntime = runtimes.at(-1);
    const modePath = REQUIRED_EXTENSIONS.find(p => p.endsWith('/modes.ts'));
    failedRuntime.services.resourceLoader.getExtensions().extensions.find(e => e.path === modePath)
      .handlers.get('before_agent_start').push(async event => {
        if (event.prompt === 'fixture-runtime-failure') throw new Error('fixture required runtime failure');
      });
    await assert.rejects(engine.piHeadlessRun({ ...target('minimal'), sessionPath: recovery.file }, { message: 'fixture-runtime-failure' }).done,
      error => error.message === 'Required extension failed: ' + modePath + ': fixture required runtime failure');
    recoveryFile = recovery.file;
    const beforeRecovery = runtimes.length;
    let oldHealthyPrompts = 0;
    const oldPrompt = failedRuntime.session.prompt.bind(failedRuntime.session);
    failedRuntime.session.prompt = async (...args) => { oldHealthyPrompts++; return oldPrompt(...args); };
    const healthyRequests = () => log().filter(e => e.request?.messages.some(m => m.role === 'user' &&
      (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes('fixture-healthy-after-error'))).length;
    let healthy;
    try {
      healthy = await engine.piHeadlessRun({ ...target('minimal'), sessionPath: recovery.file }, { message: 'fixture-healthy-after-error' }).done;
    } catch (error) {
      console.error(JSON.stringify({ recoveryFailure: { oldHealthyPrompts, healthyRequests: healthyRequests(),
        beforeRecovery, afterRecovery: runtimes.length, failedRuntimeDisposals: disposals.get(failedRuntime) || 0 } }));
      throw error;
    }
    assert.equal(healthy.warm, true);
    assert.equal(oldHealthyPrompts, 0, 'no subsequent prompt enters the poisoned runtime');
    assert.equal(disposals.get(failedRuntime), 1);
    assert.ok(disposedRuntimes.has(failedRuntime));
    assert.equal(runtimes.length, beforeRecovery + 1);
    assert.notEqual(runtimes.at(-1), failedRuntime);
    assert.equal(healthyRequests(), 1);
    engine.stopWarmSession(recovery.file); recoveryFile = undefined;
    // The same unavailable required tool must fail fresh selection AND a persisted snapshot.
    const mode = { key: 'missing', label: 'Missing', appendix: 'Fixture mode', tools: ['fixture-missing-tool'] };
    const modeFile = path.join(root, 'missing-mode.json'); json(modeFile, mode);
    await assert.rejects(engine.piBeginWarm({ ...target('minimal'), extraArgs: [...target('minimal').extraArgs, '--prompt-mode-file', modeFile] }), /Prompt mode startup failed: mode missing requests unavailable tool: fixture-missing-tool/);
    assert.equal(engine.listWarmSessions().length, 1);
    process.exitCode = 0; // expected extension failure is local to this fixture process
    const saved = SDK.SessionManager.create(cwd, path.join(root, 'sessions'));
    const { modeSha256 } = require('../../delegation.js');
    saved.appendCustomEntry('mode-switch', { definition: mode, mode: mode.key, sha256: modeSha256(mode) });
    saved._rewriteFile(); saved.flushed = true;
    await assert.rejects(engine.piHeadlessRun({ ...target('minimal'), sessionPath: saved.getSessionFile() }, { message: 'must not be consumed' }).done, /fixture-missing-tool/);
    process.exitCode = 0;
    assert.equal(SDK.SessionManager.open(saved.getSessionFile()).getEntries().filter(e => e.type === 'message' && e.message.role === 'user').length, 0);
    // Canonical agent dir, not legacy PI_AGENT_DIR, provides this named mode.
    json(path.join(agent, 'modes/canonical.json'), { key: 'canonical', label: 'Canonical', appendix: 'canonical fixture mode' });
    const canonical = await engine.piBeginWarm({ ...target('minimal'), extraArgs: [...target('minimal').extraArgs, '--prompt-mode', 'canonical'] });
    assert.equal(SDK.SessionManager.open(canonical.file).getEntries().find(e => e.customType === 'mode-switch').data.mode, 'canonical');
    // Explicit broken extension fails with its exact identity and never creates a warm session.
    const broken = path.join(root, 'broken.ts'); put(broken, 'export default () => { throw Error("fixture load failure"); };');
    await assert.rejects(engine.piBeginWarm({ ...target('minimal'), extraArgs: [...target('minimal').extraArgs, '-e', broken] }), error => error.message.includes(broken) && error.message.includes('fixture load failure'));
    // Optional ambient load failures in all are surfaced, not hidden or
    // misclassified as required-app failures. The event includes real state.
    const optionalBad = path.join(agent, 'extensions/optional-broken.ts');
    put(optionalBad, 'export default () => { throw Error("fixture optional failure"); };');
    const beforeOptional = events.length;
    const optionalSession = await engine.piBeginWarm(target('all'));
    assert.deepEqual(runtimes.at(-1).services.resourceLoader.getExtensions().errors,
      [{ path: optionalBad, error: 'Failed to load extension: fixture optional failure' }]);
    assert.deepEqual(events.slice(beforeOptional).filter(e => e.type === 'extension_error'),
      [{ type: 'extension_error', extensionPath: optionalBad, event: 'load', error: 'Failed to load extension: fixture optional failure' }]);
    engine.stopWarmSession(optionalSession.file); fs.unlinkSync(optionalBad);
    // Minimal without an authorized provider does not discover one implicitly.
    const noProviderTarget = { cwd, extraArgs: webExtensionArgs({ discovery: 'minimal' }) };
    const noProvider = await engine.piBeginWarm(noProviderTarget);
    assert.deepEqual(inspect(runtimes.at(-1)).paths, [...REQUIRED_EXTENSIONS, '<inline:workspace-checkpoints>'].sort());
    assert.deepEqual(runtimes.at(-1).session.modelRuntime.getAvailableSnapshot(), []);
    const requestCount = log().filter(e => e.request).length;
    await assert.rejects(engine.piHeadlessRun({ ...noProviderTarget, sessionPath: noProvider.file }, { message: 'no authorized fixture provider' }).done,
      error => error.message.startsWith('No API key found for the selected model.\n'));
    assert.equal(log().filter(e => e.request).length, requestCount);
    engine.stopWarmSession(noProvider.file);
    // Real RPC palette subprocess uses the same all/minimal argument contract.
    for (const discovery of ['minimal', 'all']) {
      const commands = await rpc.piListCommands({ ...target(discovery), env: process.env });
      const names = commands.map(c => c.name).sort();
      assert.deepEqual(names, ['delegations', 'mode', 'mode-delete', 'mode-edit', 'mode-new', 'llama', 'global', 'package', 'project', 'skill:package',
        ...(discovery === 'all' ? ['ambient-global', 'ambient-project', 'ambient-settings', 'ambient-package'] : [])].sort());
    }
    const rpcCommands = await rpc.piRpcOperation({ ...target('minimal'), discoverExtensions: true, env: process.env }, request => request({ type: 'get_commands' }));
    const llama = rpcCommands.data.commands.find(c => c.name === 'llama');
    assert.equal(llama.source, 'extension');
    assert.equal(llama.sourceInfo.path, '<inline:llama.cpp>');
    // RPC fresh/persisted mode errors reject instead of accepting an empty successful prompt.
    for (const t of [{ ...target('minimal'), extraArgs: [...target('minimal').extraArgs, '--prompt-mode-file', modeFile] }, { ...target('minimal'), sessionPath: saved.getSessionFile() }]) {
      await assert.rejects(rpc.piRpcOperation({ ...t, discoverExtensions: true, env: process.env }, request => request({ type: 'prompt', message: 'must not be consumed' }), 10000), /fixture-missing-tool/);
    }
    const rpcRun = rpc.piHeadlessRun({ ...target('minimal'), sessionPath: canonical.file, env: process.env }, { message: 'fixture-artifacts', onEvent: e => assert.notEqual(e.type, 'extension_error') });
    await rpcRun.done;
    fs.unlinkSync(process.env.WEB_POLICY_RELEASE);
    const previousHolds = log().filter(e => e.holding).length;
    const rpcHeld = rpc.piHeadlessRun({ ...target('minimal'), sessionPath: canonical.file, env: process.env }, { message: 'fixture-hold' });
    await until(() => log().filter(e => e.holding).length === previousHolds + 1);
    const activePid = rpc.listWarmSessions().find(s => s.sessionPath === canonical.file).pid;
    await rpc.piSetThinking({ ...target('all'), sessionPath: canonical.file, env: process.env }, 'high');
    assert.equal(rpc.listWarmSessions().find(s => s.sessionPath === canonical.file).pid, activePid);
    put(process.env.WEB_POLICY_RELEASE, 'release'); await rpcHeld.done;
    await rpc.piSetThinking({ ...target('all'), sessionPath: canonical.file, env: process.env }, 'high');
    assert.notEqual(rpc.listWarmSessions().find(s => s.sessionPath === canonical.file).pid, activePid);
    assert.throws(() => process.kill(activePid, 0), error => error.code === 'ESRCH');
    await rpc.piHeadlessRun({ ...target('all'), sessionPath: canonical.file, env: process.env }, { message: 'fixture-artifacts' }).done;
    // Terminal discovery path: CLI JSON mode with no discovery-disable flag (no PTY/UI claim).
    const cli = require('../../runtime.js').piCommand(['--mode', 'json', '--no-session', '-e', provider, 'terminal fixture'], { env: process.env });
    const output = execFileSync(cli.file, cli.args, { cwd, env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.ok(output.includes('offline fixture complete'));
    const terminalStartup = log().filter(e => e.startup).at(-1).startup;
    assert.equal(terminalStartup.mode, 'json');
    const terminalCommands = await rpc.piListCommands({ cwd, env: process.env, extraArgs: ['-e', provider] });
    assert.deepEqual(terminalCommands.map(c => c.name).sort(), ['ambient-global', 'ambient-project', 'ambient-settings', 'ambient-package', 'llama', 'global', 'package', 'project', 'skill:package'].sort());
    const modeError = 'Prompt mode startup failed: mode missing requests unavailable tool: fixture-missing-tool';
    assert.deepEqual(events.filter(e => e.type === 'extension_error').map(e => [e.extensionPath, e.event, e.error]), [
      [modePath, 'before_agent_start', 'fixture required runtime failure'],
      [modePath, 'session_start', modeError], [modePath, 'session_start', modeError], [optionalBad, 'load', 'Failed to load extension: fixture optional failure'],
    ]);
    assert.equal(runtimes.length, 10);
    evidence = { sdk: '0.87.1', minimal: min.paths, all: full.paths, resourcesPreserved: true, artifacts: ['show', 'artifact'],
      modeFailures: ['fresh', 'persisted'], rpc: ['minimal', 'all', 'mode-errors', 'artifacts', 'active/idle-policy'],
      rpcBuiltin: '<inline:llama.cpp>', terminal: 'CLI discovery (no PTY)', unanticipatedExtensionErrors: 0,
      expectedStartupErrors: 2, expectedRuntimeErrors: 1, expectedAmbientLoadErrors: 1,
      runtimeRecovery: 'dispose-before-healthy-prompt', checkpointsPreserved: true, sentinelContexts: sentinelContexts.length };
  } finally {
    rpc.stopAllWarmSessions(); await engine.dispose();
    assert.deepEqual(engine.listWarmSessions(), []);
    assert.deepEqual(runtimes.map(runtime => disposals.get(runtime)), Array(runtimes.length).fill(1));
  }
  console.log(JSON.stringify({ ...evidence, runtimeDisposals: disposals.size }));
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const source = server.slice(server.indexOf('const DOCUMENT_EXT ='), server.indexOf('// Serve a document-relative asset'));
const sha256Hex = text => crypto.createHash('sha256').update(text).digest('hex');
const mdx = `---\ntitle: Make your first request\n---\n\nimport DocsExample from '../../../components/DocsExample.astro';\n\nexport const settings = {\n  label: 'example',\n};\n\n# Hello\n\n<DocsExample recipe="first-request" />\n\n{settings.label}\n\n\`\`\`js\nconsole.log('hello');\n\`\`\`\n`;

async function harness(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'document-format-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  const events = [];
  const ctx = vm.createContext({ fs, fsp, path, sha256Hex, NOTES_DIR: path.join(root, 'notes'),
    titlePublication: require('../title-publication').createTitlePublication({ namesAllowed: () => false }),
    editableReviewFile: async p => p, editableFilePath: async p => p,
    writeFileAtomic: async (p, text) => { await fsp.writeFile(p + '.tmp', text); await fsp.rename(p + '.tmp', p); },
    observeFileHistory: (p, data) => { events.push({ path: p, ...data }); return ''; },
    fileArchive: null, ledgerRecordEditorSave: (p, data) => events.push({ path: p, ...data }),
    recentFilesTouch: (p, data) => events.push({ path: p, recent: true, ...data }),
    gitText: async (_root, args) => git(args),
    gitTrackedPaths: async () => git(['ls-files', '-z']).split('\0').filter(Boolean),
    projectMetaFor: () => ({ cwd: root }), projectGitRepositories: async () => [root],
    recentProjectFileActivity: () => null,
    // Shared documents and people: not exercised here.
    collab: { has: () => false, setText: () => false }, collabDiskWritten: () => {}, usersLib: { ownerOf: () => ({ id: 'owner' }) }, roster: {},
  });
  vm.runInContext(source, ctx);
  // Revision naming is unrelated to saving formats; never start background model calls.
  vm.runInContext('scheduleDocCommitTitle = () => {};', ctx);
  return { root, git, ctx, events };
}

test('every document format routed to MRMD can save and commit, with stale-write protection', async t => {
  const { root, git, ctx, events } = await harness(t);
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../filesmode.js'), 'utf8'), browser);
  for (const [i, extension] of ['md', 'MD', 'mdx', 'MDX', 'markdown', 'qmd', 'rmd'].entries()) {
    // One name per case: on macOS and Windows, first-request.md and .MD are one file.
    const name = `first-request-${i}.${extension}`;
    const file = path.join(root, name);
    assert.equal(browser.fileWsKind(file), 'md');
    await fsp.writeFile(file, mdx);
    const text = mdx.replace('# Hello', '# Updated');
    const saved = await ctx.docSaveResponse({ path: file, text, baseSha: sha256Hex(mdx) });
    assert.equal(saved.sha, sha256Hex(text));
    assert.equal(await fsp.readFile(file, 'utf8'), text, 'imports, JSX and expressions must survive unchanged');
    assert.equal((await ctx.docSaveResponse({ path: file, text, baseSha: saved.sha })).changed, false);
    await assert.rejects(ctx.docSaveResponse({ path: file, text: 'stale', baseSha: sha256Hex(mdx) }), /changed on disk/);
    assert.equal(await fsp.readFile(file, 'utf8'), text);
    const revision = await ctx.docCommitResponse({ path: file, text, baseSha: saved.sha });
    assert.ok(revision.hash);
    assert.equal(git(['show', `HEAD:${name}`]), text);
    assert.ok(events.some(e => e.path === file && e.source === 'Markdown save'));
    // Both sources join recents, retaining their distinct actor.
    assert.ok(events.some(e => e.path === file && e.recent && e.kind === 'saved'));
    events.length = 0;
    await ctx.docSaveResponse({ path: file, text: text + '\nagent\n', baseSha: saved.sha, actor: 'ai' });
    assert.ok(events.some(e => e.recent && e.actor === 'agent' && e.kind === 'edited'));
    assert.equal(events.some(e => e.recent && e.actor === 'human'), false);
  }
  for (const extension of ['js', 'mdx.js', 'md.bak', 'txt']) {
    const file = path.join(root, 'not-a-document.' + extension);
    assert.equal(browser.fileWsKind(file), 'code');
    await fsp.writeFile(file, 'untouched');
    await assert.rejects(ctx.docSaveResponse({ path: file, text: 'replace' }), /only Markdown-family/);
    await assert.rejects(ctx.docCommitResponse({ path: file }), /only Markdown-family/);
    assert.equal(await fsp.readFile(file, 'utf8'), 'untouched');
  }
});

test('creation preserves requested document extensions, defaults to md, and refuses duplicates', async t => {
  const { root, ctx } = await harness(t);
  for (const [name, file, title] of [
    ['New guide', 'New-guide.md', 'New guide'],
    ['First request.mdx', 'First-request.mdx', 'First request'],
    ['Upper.MDX', 'Upper.MDX', 'Upper'],
    ['Notebook.qmd', 'Notebook.qmd', 'Notebook'],
  ]) {
    const result = await ctx.docCreateResponse({ project: 'fixture', name });
    assert.equal(result.path, path.join(root, 'documents', file));
    assert.equal(await fsp.readFile(result.path, 'utf8'), `# ${title}\n\n`);
    await assert.rejects(ctx.docCreateResponse({ project: 'fixture', name }), /already exists/);
  }
});

test('document catalog includes tracked and untracked MDX, including uppercase extensions', async t => {
  const { root, git, ctx } = await harness(t);
  for (const file of ['tracked.mdx', 'untracked.MDX', 'notes.md', 'other.markdown', 'ignored.mdx', 'code.js']) {
    await fsp.writeFile(path.join(root, file), mdx);
  }
  await fsp.writeFile(path.join(root, '.gitignore'), 'ignored.mdx\n');
  git(['add', 'tracked.mdx']);
  const result = await ctx.projectDocsResponse('fixture');
  assert.deepEqual(Array.from(result.docs, d => d.rel).sort(), ['notes.md', 'other.markdown', 'tracked.mdx', 'untracked.MDX']);
});

test('MDX disables prose unwrapping even when invoked directly', () => {
  const start = app.indexOf('  const canUnwrap =');
  const code = app.slice(start, app.indexOf("  $('docReload').onclick", start));
  for (const file of ['guide.mdx', 'guide.MDX', 'guide.md']) {
    const button = {};
    let changes = 0;
    const ctx = vm.createContext({ text: mdx, $: () => button,
      unwrapHardLines: () => ({ text: 'joined', joins: 3 }),
      st: { path: file, editor: { getContent: () => mdx, setContent: () => changes++ } }, toast() {},
    });
    vm.runInContext(code, ctx);
    assert.equal(button.hidden, file !== 'guide.md');
    button.onclick();
    assert.equal(changes, file === 'guide.md' ? 1 : 0);
  }
});

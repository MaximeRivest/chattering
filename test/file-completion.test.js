'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { completeFiles } = require('../file-completion');
const { piPackageDir } = require('../pisdk-runtime');
test('installed Pi completion returns insertion paths relative to the session, including spaces', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'completion-')));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'sample file.js'), 'example');
    const items = await completeFiles({ piDir: piPackageDir(), root, cwd: path.join(root, 'src'), query: 'sample', signal: new AbortController().signal });
    assert.ok(items.some(i => i.value === '@"../sample file.js"'));
    await fs.mkdir(path.join(root, 'other folder', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'other folder', 'child.js'), 'child');
    await fs.writeFile(path.join(root, 'other folder', 'nested', 'deep.js'), 'deep');
    const complete = query => completeFiles({ piDir: piPackageDir(), root, cwd: path.join(root, 'src'), query, signal: new AbortController().signal });
    const folders = await complete('other');
    const folder = folders.find(i => i.label === 'other folder/');
    assert.equal(folder.value, '@"../other folder/"');
    assert.equal(folder.description, folder.value);
    assert.equal(folder.directory, true);
    const children = await complete(folder.value.slice(1, -1));
    assert.deepEqual(children.map(i => i.label), ['nested/', 'child.js']);
    assert.ok(children.every(i => i.description === i.value));
    assert.equal((await complete('../other folder/ch'))[0].value, '@"../other folder/child.js"');
    assert.deepEqual((await complete(path.join(root, 'other folder') + '/')).map(i => i.value), children.map(i => i.value));
    await fs.mkdir(path.join(root, 'src', 'local'));
    assert.equal((await complete('./'))[0].value, '@./local/');
    assert.equal((await complete('./local/')).length, 0);
    const ctl = new AbortController(); ctl.abort();
    assert.deepEqual(await completeFiles({ piDir: piPackageDir(), root, cwd: root, query: '', signal: ctl.signal }), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

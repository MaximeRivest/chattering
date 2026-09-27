'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const NE = require('../notebook-env.js');

test('addDependency creates front matter when there is none', () => {
  const out = NE.addDependency('# Title\n\ntext\n', 'websockets');
  assert.equal(out, '---\nrat:\n  python:\n    dependencies:\n      - websockets\n---\n# Title\n\ntext\n');
  assert.deepEqual(NE.dependencies(out), ['websockets']);
});

test('addDependency keeps unrelated front matter and appends to an existing list', () => {
  const doc = '---\ntitle: x\nrat:\n  project: ../..\n  python:\n    requires: ">=3.11"\n    dependencies:\n      - -e .\n      - websockets\n---\n# body\n';
  const out = NE.addDependency(doc, 'matplotlib');
  assert.equal(out, '---\ntitle: x\nrat:\n  project: ../..\n  python:\n    requires: ">=3.11"\n    dependencies:\n      - -e .\n      - websockets\n      - matplotlib\n---\n# body\n');
  assert.deepEqual(NE.dependencies(out), ['-e .', 'websockets', 'matplotlib']);
});

test('addDependency is idempotent', () => {
  const doc = '---\nrat:\n  python:\n    dependencies:\n      - websockets\n---\n';
  assert.equal(NE.addDependency(doc, 'websockets'), doc);
});

test('addDependency adds the rat key to front matter that lacks it', () => {
  const out = NE.addDependency('---\ntitle: T\n---\nbody\n', 'rich');
  assert.equal(out, '---\ntitle: T\nrat:\n  python:\n    dependencies:\n      - rich\n---\nbody\n');
});

test('addDependency adds python: under an existing rat: block using its indentation', () => {
  const out = NE.addDependency('---\nrat:\n    project: ..\nother: 1\n---\n', 'rich');
  assert.equal(out, '---\nrat:\n    project: ..\n    python:\n      dependencies:\n        - rich\nother: 1\n---\n');
});

test('addDependency adds dependencies: under an existing python: block', () => {
  const out = NE.addDependency('---\nrat:\n  python:\n    requires: ">=3.11"\n---\n', 'rich');
  assert.equal(out, '---\nrat:\n  python:\n    requires: ">=3.11"\n    dependencies:\n      - rich\n---\n');
});

test('addDependency handles a flow list and quotes what YAML needs quoted', () => {
  const out = NE.addDependency('---\nrat:\n  python:\n    dependencies: [websockets]\n---\n', '-e .');
  assert.equal(out, '---\nrat:\n  python:\n    dependencies: [websockets, "-e ."]\n---\n');
  assert.deepEqual(NE.dependencies(out), ['websockets', '-e .']);
  const block = NE.addDependency('---\nrat:\n  python:\n    dependencies:\n      - x\n---\n', 'lm15 @ git+https://example.com/lm15@main');
  assert.match(block, /- lm15 @ git\+https:\/\/example\.com\/lm15@main\n/);
});

test('addDependency refuses shapes it does not understand instead of guessing', () => {
  assert.equal(NE.addDependency('---\nrat: {python: {dependencies: [a]}}\n---\n', 'b'), null);
  assert.equal(NE.addDependency('---\nrat:\n\tpython: 1\n---\n', 'b'), null);
  assert.equal(NE.addDependency('---\nrat:\n  python:\n    dependencies: weird\n---\n', 'b'), null);
  assert.equal(NE.addDependency('x', ''), null);
  assert.equal(NE.addDependency('x', 'a\nb'), null);
});

test('addDependency preserves CRLF endings', () => {
  const out = NE.addDependency('---\r\nrat:\r\n  python:\r\n    dependencies:\r\n      - a\r\n---\r\nbody\r\n', 'b');
  assert.equal(out, '---\r\nrat:\r\n  python:\r\n    dependencies:\r\n      - a\r\n      - b\r\n---\r\nbody\r\n');
});

test('missingModule and proposeRequirement', () => {
  const out = "Traceback ...\n  File \"<rat>\", line 1\nModuleNotFoundError: No module named 'dspy.teleprompt'\n";
  assert.equal(NE.missingModule(out), 'dspy');
  assert.equal(NE.missingModule('all good'), null);
  assert.equal(NE.proposeRequirement('dspy', 'dspy'), '-e .');
  assert.equal(NE.proposeRequirement('dspy_ai', 'DSPy-AI'), '-e .');
  assert.equal(NE.proposeRequirement('cv2', 'dspy'), 'opencv-python');
  assert.equal(NE.proposeRequirement('websockets', null), 'websockets');
  assert.equal(NE.proposeRequirement(null, 'x'), null);
});

test('findRat prefers RAT_BIN, then PATH, then known install dirs', () => {
  const files = new Set(['/opt/rat', '/usr/local/bin/rat', '/home/u/.local/bin/rat']);
  const exists = p => files.has(p);
  assert.deepEqual(NE.findRat({ env: { RAT_BIN: '/opt/rat', PATH: '/usr/local/bin' }, homedir: '/home/u', exists }), { path: '/opt/rat', source: 'RAT_BIN' });
  assert.equal(NE.findRat({ env: { RAT_BIN: '/nope', PATH: '/usr/local/bin' }, homedir: '/home/u', exists }).path, null);
  assert.deepEqual(NE.findRat({ env: { PATH: '/bin:/usr/local/bin' }, homedir: '/home/u', exists }), { path: '/usr/local/bin/rat', source: 'PATH' });
  const fb = NE.findRat({ env: { PATH: '/bin' }, homedir: '/home/u', exists });
  assert.equal(fb.path, '/home/u/.local/bin/rat');
  assert.equal(fb.source, 'fallback');
  assert.equal(NE.findRat({ env: { PATH: '/bin' }, homedir: '/home/x', exists }).path, null);
  const win = NE.findRat({ env: { PATH: 'C:\\tools' }, platform: 'win32', homedir: 'C:\\Users\\u', exists: p => p === 'C:\\tools\\rat.exe' });
  assert.equal(win.path, 'C:\\tools\\rat.exe');
});

test('agentBrief carries the report, the plan, the editable lines and the rules; nothing is invented', () => {
  const report = {
    notebook: '/p/documents/notebooks/x.md', project: '/p',
    checks: [
      { id: 'project', label: 'project', ok: true, detail: '/p (front matter)' },
      { id: 'requirements', label: 'requirements', ok: false, detail: '"-e ." points to /p, which has no pyproject.toml or setup.py', hint: 'fix the line; this project\u0027s own packages are installed from: -e ./python (lmcc)' },
    ],
    after: [{ path: '/p/documents/notebooks/base.md', played: false }],
    actions: [{ label: 'install requirements', effect: 'kernel restarts — variables reset' }],
    python: { editable: [{ name: 'lmcc', line: '-e ./python' }] },
  };
  const brief = NE.agentBrief(report, { path: '/p/documents/notebooks/x.md', lastOutput: 'Traceback\nModuleNotFoundError: x', focus: 'line 12, python cell' });
  assert.match(brief, /^Make this notebook run, end to end, on a fresh kernel: `\/p\/documents\/notebooks\/x\.md`\./);
  assert.match(brief, /✗ requirements — "-e \." points to \/p/);
  assert.match(brief, /→ fix the line; this project/);
  assert.match(brief, /prerequisite base\.md \(not yet run in this kernel\)/);
  assert.match(brief, /planned by `rat ensure`: install requirements \[kernel restarts — variables reset\]/);
  assert.match(brief, /`-e \.\/python` \(lmcc\)/);
  assert.match(brief, /Last failing cell \(line 12, python cell\) printed:\n```\nTraceback\nModuleNotFoundError: x\n```/);
  assert.match(brief, /rat doctor documents\/notebooks\/x\.md --json/, 'paths as the agent runs them, from the project root');
  assert.match(brief, /rat play documents\/notebooks\/x\.md/);
  assert.match(brief, /never with a pip install inside a cell/);
  assert.match(brief, /Do not claim it works unless `rat play` passed/);
  const missing = NE.agentBrief({ ratMissing: true }, { path: '/p/n.md' });
  assert.match(missing, /rat is not installed/);
  assert.doesNotMatch(missing, /doctor report right now/);
});

test('parseLookOverview reads rat look: header, then name / type / preview columns', () => {
  const out = NE.parseLookOverview("python idle | 3 vars\n\nauth                Auth              Auth(FileStore(/x/credentials.json))\ncurrent             NoneType          None\nreply               Response          Response(\\n    text='Hi  there')\n");
  assert.deepEqual([out.language, out.state, out.count], ['python', 'idle', 3]);
  assert.deepEqual(out.vars, [
    { name: 'auth', type: 'Auth', preview: 'Auth(FileStore(/x/credentials.json))' },
    { name: 'current', type: 'NoneType', preview: 'None' },
    { name: 'reply', type: 'Response', preview: "Response(\\n    text='Hi  there')" },
  ]);
  assert.deepEqual(NE.parseLookOverview('python idle | 0 vars\n').vars, []);
  assert.deepEqual(NE.parseLookOverview('something odd').vars, [{ name: 'something odd', type: '', preview: '' }]);
});

test('R: addDependency writes rat.r.dependencies, missingPackage reads R\u2019s error, the brief speaks R only for R notebooks', () => {
  const text = '---\nrat:\n  python:\n    dependencies:\n      - x\n---\nbody\n';
  const out = NE.addDependency(text, 'dplyr', 'r');
  assert.equal(out, '---\nrat:\n  python:\n    dependencies:\n      - x\n  r:\n    dependencies:\n      - dplyr\n---\nbody\n');
  assert.equal(NE.addDependency(out, 'dplyr', 'r'), out, 'idempotent');
  assert.deepEqual(NE.dependencies(out, 'r'), ['dplyr']);
  assert.deepEqual(NE.dependencies(out), ['x']);
  assert.equal(NE.addDependency(text, 'x', 'r; rm'), null, 'a section is a plain word');
  assert.deepEqual(NE.missingPackage('Error in library(praise) : there is no package called \u2018praise\u2019', 'r'), { name: 'praise', section: 'r' });
  assert.deepEqual(NE.missingPackage("Error in library(data.table) : there is no package called 'data.table'", 'r'), { name: 'data.table', section: 'r' });
  assert.deepEqual(NE.missingPackage("ModuleNotFoundError: No module named 'cv2'", 'py'), { name: 'cv2', section: 'python' });
  assert.equal(NE.missingPackage("ModuleNotFoundError: No module named 'cv2'", 'r'), null);
  const report = { notebook: '/p/n.md', project: '/p', checks: [], r: { library: '/p/.rat/r-library/x/R-4.6', renv: false } };
  assert.match(NE.agentBrief(report, { path: '/p/n.md' }), /rat\.r\.dependencies/);
  assert.doesNotMatch(NE.agentBrief({ ...report, r: undefined }, { path: '/p/n.md' }), /rat\.r\.|install\.packages/);
});

test('Julia: the package error, the header section, the brief', () => {
  const err = 'ERROR: ArgumentError: Package Example not found in current path.\n- Run `import Pkg; Pkg.add("Example")` to install the Example package.';
  assert.deepEqual(NE.missingPackage(err, 'jl'), { name: 'Example', section: 'julia' });
  assert.equal(NE.missingPackage(err, 'py'), null);
  assert.equal(NE.addDependency('# t\n', 'Example', 'julia'), '---\nrat:\n  julia:\n    dependencies:\n      - Example\n---\n# t\n');
  const report = { notebook: '/p/n.md', project: '/p', checks: [], julia: { environment: '/p/.rat/julia' } };
  const brief = NE.agentBrief(report, { path: '/p/n.md' });
  assert.match(brief, /rat\.julia\.dependencies/);
  assert.match(brief, /rat restart jl/);
  assert.doesNotMatch(brief, /rat\.r\./);
});

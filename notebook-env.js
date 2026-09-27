// Notebook environment helpers shared by the server and the browser.
//
// A Markdown notebook declares what it needs in its front matter under one
// key (the contract is rat's — see `rat ensure --help`):
//
//   ---
//   rat:
//     project: ../..
//     python:
//       requires: ">=3.11"
//       dependencies:
//         - -e .
//         - websockets
//   ---
//
// This file knows how to add a requirement to that declaration without
// disturbing the author's formatting, how to turn a failed import into a
// requirement to propose, and where the rat binary lives on this machine.
// It executes nothing; rat does.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NotebookEnv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- front matter editing ----

  // Split text into { front: [lines between the --- fences] | null, open, close }
  // where open/close are line indexes of the fences (close is the closing fence).
  function frontMatter(lines) {
    if (lines.length === 0 || lines[0].replace(/\s+$/, '') !== '---') return null;
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].replace(/\s+$/, '');
      if (t === '---' || t === '...') return { open: 0, close: i };
    }
    return null;
  }

  const indentOf = line => (line.match(/^ */) || [''])[0].length;
  const isBlank = line => /^\s*$/.test(line) || /^\s*#/.test(line);
  // "key:" or "key: value" at exactly the given indent.
  const keyAt = (line, indent, key) => indentOf(line) === indent && new RegExp('^ {' + indent + '}' + key + '\\s*:').test(line);

  // Find the block of a mapping key: returns { line, indent, end } where end
  // is the index after the last line belonging to the key's value. null if
  // the key is absent between [from, to).
  function findKey(lines, from, to, indent, key) {
    for (let i = from; i < to; i++) {
      if (!keyAt(lines[i], indent, key)) continue;
      let end = i + 1;
      while (end < to && (isBlank(lines[end]) || indentOf(lines[end]) > indent)) end++;
      // Trailing blank lines belong to the parent, not the key.
      while (end > i + 1 && isBlank(lines[end - 1])) end--;
      return { line: i, indent, end };
    }
    return null;
  }

  const quoteIfNeeded = s => /^[A-Za-z0-9._\-\[\]=<>!~,+@:\/ ]+$/.test(s) && !/^[-@]/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s);
  // A requirement that starts with "-" or "@" must be quoted in YAML; JSON
  // strings are valid YAML double-quoted scalars.

  // Add `requirement` to rat.python.dependencies. Returns the new text, the
  // same text when the requirement is already declared, or null when the
  // front matter has a shape this editor does not understand (flow mappings,
  // tabs) — the caller then asks the person to edit it by hand rather than
  // guessing.
  function addDependency(text, requirement) {
    requirement = String(requirement || '').trim();
    if (!requirement || /[\r\n]/.test(requirement)) return null;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const item = quoteIfNeeded(requirement);
    const fm = frontMatter(lines);
    if (!fm) {
      const block = ['---', 'rat:', '  python:', '    dependencies:', '      - ' + item, '---'];
      return block.join(nl) + nl + text;
    }
    const inner = lines.slice(fm.open + 1, fm.close);
    if (inner.some(l => /^\t/.test(l))) return null;
    const rat = findKey(inner, 0, inner.length, 0, 'rat');
    if (!rat) {
      inner.push('rat:', '  python:', '    dependencies:', '      - ' + item);
      return join(lines, fm, inner, nl);
    }
    if (/^rat\s*:\s*\S/.test(inner[rat.line])) return null; // rat: {flow}
    const childIndent = firstChildIndent(inner, rat) ?? rat.indent + 2;
    const python = findKey(inner, rat.line + 1, rat.end, childIndent, 'python');
    if (!python) {
      const pad = ' '.repeat(childIndent);
      inner.splice(rat.end, 0, pad + 'python:', pad + '  dependencies:', pad + '    - ' + item);
      return join(lines, fm, inner, nl);
    }
    if (/^ *python\s*:\s*\S/.test(inner[python.line])) return null;
    const pyChild = firstChildIndent(inner, python) ?? python.indent + 2;
    const deps = findKey(inner, python.line + 1, python.end, pyChild, 'dependencies');
    if (!deps) {
      const pad = ' '.repeat(pyChild);
      inner.splice(python.end, 0, pad + 'dependencies:', pad + '  - ' + item);
      return join(lines, fm, inner, nl);
    }
    const head = inner[deps.line];
    const flow = head.match(/^( *dependencies\s*:\s*)\[(.*)\]\s*$/);
    if (flow) {
      const existing = flow[2].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (existing.includes(requirement)) return text;
      inner[deps.line] = flow[1] + '[' + existing.concat(item).join(', ') + ']';
      return join(lines, fm, inner, nl);
    }
    if (!/^ *dependencies\s*:\s*$/.test(head)) return null;
    const items = [];
    let itemIndent = null;
    for (let i = deps.line + 1; i < deps.end; i++) {
      const m = inner[i].match(/^( *)- (.*)$/);
      if (!m) { if (isBlank(inner[i])) continue; return null; }
      if (itemIndent === null) itemIndent = m[1].length;
      items.push(m[2].trim().replace(/^["']|["']$/g, ''));
    }
    if (items.includes(requirement)) return text;
    if (itemIndent === null) itemIndent = deps.indent + 2;
    inner.splice(deps.end, 0, ' '.repeat(itemIndent) + '- ' + item);
    return join(lines, fm, inner, nl);
  }

  function firstChildIndent(lines, key) {
    for (let i = key.line + 1; i < key.end; i++) if (!isBlank(lines[i])) return indentOf(lines[i]);
    return null;
  }

  function join(lines, fm, inner, nl) {
    return lines.slice(0, fm.open + 1).concat(inner, lines.slice(fm.close)).join(nl);
  }

  // Declared dependencies (block or flow list), or [] — used to show what
  // the notebook already asks for.
  function dependencies(text) {
    const lines = text.split(/\r?\n/);
    const fm = frontMatter(lines);
    if (!fm) return [];
    const inner = lines.slice(fm.open + 1, fm.close);
    const rat = findKey(inner, 0, inner.length, 0, 'rat');
    if (!rat) return [];
    const ci = firstChildIndent(inner, rat);
    if (ci === null) return [];
    const python = findKey(inner, rat.line + 1, rat.end, ci, 'python');
    if (!python) return [];
    const pi = firstChildIndent(inner, python);
    if (pi === null) return [];
    const deps = findKey(inner, python.line + 1, python.end, pi, 'dependencies');
    if (!deps) return [];
    const flow = inner[deps.line].match(/\[(.*)\]\s*$/);
    if (flow) return flow[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const out = [];
    for (let i = deps.line + 1; i < deps.end; i++) {
      const m = inner[i].match(/^ *- (.*)$/);
      if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
    return out;
  }

  // Set (or replace) rat.project. Creates `rat:` when absent. Same shape
  // rules as addDependency: null when the front matter is not editable.
  function setProject(text, project) {
    project = String(project || '').trim();
    if (!project || /[\r\n]/.test(project)) return null;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const fm = frontMatter(lines);
    if (!fm) return ['---', 'rat:', '  project: ' + project, '---'].join(nl) + nl + text;
    const inner = lines.slice(fm.open + 1, fm.close);
    if (inner.some(l => /^\t/.test(l))) return null;
    const rat = findKey(inner, 0, inner.length, 0, 'rat');
    if (!rat) { inner.push('rat:', '  project: ' + project); return join(lines, fm, inner, nl); }
    if (/^rat\s*:\s*\S/.test(inner[rat.line])) return null;
    const childIndent = firstChildIndent(inner, rat) ?? rat.indent + 2;
    const existing = findKey(inner, rat.line + 1, rat.end, childIndent, 'project');
    const line = ' '.repeat(childIndent) + 'project: ' + project;
    if (existing) inner.splice(existing.line, existing.end - existing.line, line);
    else inner.splice(rat.line + 1, 0, line);
    return join(lines, fm, inner, nl);
  }

  // Set (or replace) a top-level front-matter mapping key with flat string
  // values, e.g. source: {conversation, entry}. Values are JSON-quoted so
  // any characters are safe. null when the front matter is not editable.
  function setMapping(text, key, values) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return null;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const block = [key + ':'].concat(Object.entries(values || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => '  ' + k + ': ' + JSON.stringify(String(v))));
    const fm = frontMatter(lines);
    if (!fm) return ['---'].concat(block, ['---']).join(nl) + nl + text;
    const inner = lines.slice(fm.open + 1, fm.close);
    if (inner.some(l => /^\t/.test(l))) return null;
    const existing = findKey(inner, 0, inner.length, 0, key);
    if (existing) inner.splice(existing.line, existing.end - existing.line, ...block);
    else inner.push(...block);
    return join(lines, fm, inner, nl);
  }

  // Read a scalar at a front-matter path, e.g. ['source', 'conversation'] or
  // ['title']. Quoted scalars are unquoted. null when absent.
  function readScalar(text, pathKeys) {
    const lines = text.split(/\r?\n/);
    const fm = frontMatter(lines);
    if (!fm) return null;
    const inner = lines.slice(fm.open + 1, fm.close);
    let from = 0, to = inner.length, indent = 0;
    for (let i = 0; i < pathKeys.length; i++) {
      const found = findKey(inner, from, to, indent, pathKeys[i]);
      if (!found) return null;
      if (i === pathKeys.length - 1) {
        const m = inner[found.line].match(/^ *[^:]+:\s*(.*)$/);
        const raw = (m ? m[1] : '').trim();
        if (!raw) return null;
        if (/^".*"$/.test(raw)) { try { return JSON.parse(raw); } catch { return raw.slice(1, -1); } }
        if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
        return raw;
      }
      from = found.line + 1; to = found.end;
      const ci = firstChildIndent(inner, found);
      if (ci === null) return null;
      indent = ci;
    }
    return null;
  }

  // The list under rat.after, or [].
  function afterList(text) {
    const lines = text.split(/\r?\n/);
    const fm = frontMatter(lines);
    if (!fm) return [];
    const inner = lines.slice(fm.open + 1, fm.close);
    const rat = findKey(inner, 0, inner.length, 0, 'rat');
    if (!rat) return [];
    const ci = firstChildIndent(inner, rat);
    if (ci === null) return [];
    const after = findKey(inner, rat.line + 1, rat.end, ci, 'after');
    if (!after) return [];
    const flow = inner[after.line].match(/\[(.*)\]\s*$/);
    if (flow) return flow[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const out = [];
    for (let i = after.line + 1; i < after.end; i++) {
      const m = inner[i].match(/^ *- (.*)$/);
      if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
    return out;
  }

  // ---- failed import → requirement ----

  // Import names that differ from the distribution that provides them. A
  // guess: the person can always edit it.
  const IMPORT_TO_DIST = {
    cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn', skimage: 'scikit-image',
    yaml: 'pyyaml', dotenv: 'python-dotenv', bs4: 'beautifulsoup4', dateutil: 'python-dateutil',
    Crypto: 'pycryptodome', git: 'GitPython', attr: 'attrs', jwt: 'PyJWT', google: 'google-api-python-client',
    fitz: 'pymupdf', docx: 'python-docx', pptx: 'python-pptx', serial: 'pyserial', usb: 'pyusb',
    OpenSSL: 'pyOpenSSL', psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient', wx: 'wxPython',
    IPython: 'ipython', Bio: 'biopython', gi: 'PyGObject', zmq: 'pyzmq', lxml: 'lxml', magic: 'python-magic',
  };

  const normalize = s => String(s || '').toLowerCase().replace(/[-_.]+/g, '-');

  // Reads "ModuleNotFoundError: No module named 'x.y'" out of cell output.
  function missingModule(output) {
    const m = String(output || '').match(/ModuleNotFoundError: No module named '([A-Za-z0-9_.]+)'/);
    return m ? m[1].split('.')[0] : null;
  }

  // The requirement line to propose for a missing import. When the module
  // is the project's own package the right line is an editable install of
  // the project, not a PyPI download of something with the same name.
  function proposeRequirement(moduleName, projectPackage) {
    if (!moduleName) return null;
    if (projectPackage && normalize(moduleName) === normalize(projectPackage)) return '-e .';
    return IMPORT_TO_DIST[moduleName] || moduleName;
  }

  // ---- a brief for a coding agent ----

  // What a coding agent needs to make a notebook run: the goal, rat's
  // verdict as it stands (checks, hints, plan, prerequisites), the last
  // failure if any, and the rules that keep the fix durable (declare in the
  // header, never pip in a cell, don't replace what is installed, prove it
  // with rat play). The notebook file itself rides along as attached context.
  function agentBrief(report, { path, lastOutput = null, focus = null } = {}) {
    const full = String(path || report?.notebook || '');
    // Commands are written as the agent will run them: from the project root.
    const project = report && report.project ? String(report.project).replace(/\/+$/, '') : '';
    const name = project && full.startsWith(project + '/') ? full.slice(project.length + 1) : full.split(/[\\/]/).pop();
    const lines = ['Make this notebook run, end to end, on a fresh kernel: `' + (path || report?.notebook || '') + '`.', ''];
    if (report && !report.ratMissing) {
      lines.push('rat\u0027s doctor report right now:');
      for (const c of report.checks || []) {
        lines.push((c.ok ? '✓' : '✗') + ' ' + c.label + (c.detail ? ' — ' + c.detail : ''));
        if (!c.ok && c.hint) lines.push('   → ' + c.hint);
      }
      for (const a of report.after || []) lines.push('   prerequisite ' + String(a.path).split(/[\\/]/).pop() + (a.played ? ' (already ran in this kernel)' : ' (not yet run in this kernel)'));
      if ((report.actions || []).length) lines.push('planned by `rat ensure`: ' + report.actions.map(a => a.label + (a.effect ? ' [' + a.effect + ']' : '')).join('; '));
      if (report.python && (report.python.editable || []).length) lines.push('this project\u0027s own packages, as installed in its environment: ' + report.python.editable.map(e => '`' + e.line + '` (' + e.name + ')').join(', '));
      lines.push('');
    } else if (report && report.ratMissing) {
      lines.push('rat is not installed on this machine (or not on PATH). Install it first — https://runanything.dev — then continue.', '');
    }
    if (lastOutput) lines.push('Last failing cell' + (focus ? ' (' + focus + ')' : '') + ' printed:', '```', String(lastOutput).trim().split('\n').slice(-25).join('\n'), '```', '');
    lines.push(
      'Please:',
      '1. Read the front matter (`rat.python.dependencies`, `rat.python.requires`, `rat.after`) and the report above. The header is the declaration: fix problems there, never with a pip install inside a cell.',
      '2. Work with rat: `rat doctor ' + name + ' --json` to see the plan, `rat ensure ' + name + '` to carry it out. Do not reinstall or replace what is already installed; editable checkouts stay editable (use the `-e` lines listed above for this project\u0027s own packages).',
      '3. Prove it: `rat restart py` for this project, then `rat play ' + name + '` — every cell must run top to bottom. If a cell fails for a code reason, change the notebook minimally and say exactly what you changed and why.',
      '4. Report: what was wrong, what you changed (header, environment, or code), and the final `rat doctor` result. Do not claim it works unless `rat play` passed.',
    );
    return lines.join('\n');
  }

  // ---- locating rat ----

  // Where rat is: an explicit RAT_BIN, then PATH, then the places rat's own
  // installer and `go build` put it. Pure: the caller supplies the probes.
  function findRat({ env = {}, platform = 'linux', homedir = '', exists = () => false, pathSep }) {
    const exe = platform === 'win32' ? 'rat.exe' : 'rat';
    const sep = pathSep || (platform === 'win32' ? ';' : ':');
    const dirSep = platform === 'win32' ? '\\' : '/';
    const joinPath = (a, b) => a.replace(/[\\/]+$/, '') + dirSep + b;
    if (env.RAT_BIN) return exists(env.RAT_BIN) ? { path: env.RAT_BIN, source: 'RAT_BIN' } : { path: null, source: 'RAT_BIN', note: 'RAT_BIN=' + env.RAT_BIN + ' does not exist' };
    for (const dir of String(env.PATH || '').split(sep).filter(Boolean)) {
      const p = joinPath(dir, exe);
      if (exists(p)) return { path: p, source: 'PATH' };
    }
    const fallbacks = platform === 'win32'
      ? [joinPath(joinPath(homedir, '.local'), 'bin'), joinPath(joinPath(homedir, 'go'), 'bin')]
      : [joinPath(joinPath(homedir, '.local'), 'bin'), joinPath(joinPath(homedir, 'go'), 'bin'), joinPath(joinPath(homedir, '.nix-profile'), 'bin')];
    for (const dir of fallbacks) {
      const p = joinPath(dir, exe);
      if (exists(p)) return { path: p, source: 'fallback', note: p + ' is not on this server\u0027s PATH' };
    }
    return { path: null, source: 'none' };
  }

  // Fence languages a notebook cell can run in → rat runtimes. The server
  // runs cells through it; the page offers a Run button only for these.
  // rat resolves aliases itself; this map only decides what is runnable.
  const RUN_LANGS = Object.freeze({ python: 'py', py: 'py', python3: 'py', r: 'r', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', julia: 'jl', jl: 'jl', javascript: 'js', js: 'js', node: 'js' });

  // `rat look <runtime>` (no --at): a header "python idle | 18 vars", a
  // blank line, then one row per variable — name, type, preview — in
  // columns at least two spaces apart. Rows that do not fit are kept whole
  // as the preview, so nothing the kernel said is dropped.
  function parseLookOverview(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const head = (lines[0] || '').match(/^(\S+)\s+(\S+)\s*\|\s*(\d+)\s+vars?\b/);
    const vars = [];
    for (const line of lines.slice(head ? 1 : 0)) {
      if (!line.trim()) continue;
      const m = line.match(/^\s*(\S+)\s{2,}(\S+)\s{2,}(.*)$/) || line.match(/^\s*(\S+)\s{2,}(\S+)\s*$/);
      vars.push(m ? { name: m[1], type: m[2], preview: m[3] || '' } : { name: line.trim(), type: '', preview: '' });
    }
    return { language: head ? head[1] : null, state: head ? head[2] : null, count: head ? Number(head[3]) : vars.length, vars };
  }

  return { addDependency, dependencies, setProject, setMapping, readScalar, afterList, missingModule, proposeRequirement, agentBrief, findRat, IMPORT_TO_DIST, RUN_LANGS, parseLookOverview };
});

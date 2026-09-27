'use strict';
// Location inference never executes shell text. Unsupported expansion stays
// unresolved; remote paths never fall through to the local process cwd.
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const VERSION = 2;
const key = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const platform = require('./platform.js');
// Secrets never captured, shown or served. Either separator counts: on
// Windows C:\Users\u\.ssh\id_rsa is as secret as /home/u/.ssh/id_rsa.
const sensitive = file => /(?:^|\/)\.(?:env(?:\.|$)|ssh(?:\/|$)|gnupg(?:\/|$))|\.(?:pem|key|p12|pfx)$|(?:^|\/)(?:auth|credentials)\.json$/i.test(String(file).replace(/\\/g, '/'));
// Folders outside a workspace whose files an agent's step may name and have
// captured or shown: the home folder and the temporary folders, as
// [given, on disk] pairs, since a path can arrive under either name
// (macOS: /tmp and /var/folders are links into /private).
function outsideFolders() {
  const given = [os.homedir(), os.tmpdir(), ...(platform.IS_WIN ? [] : ['/tmp'])].filter(Boolean);
  return [...new Map(given.map(dir => [dir, [dir, platform.realFolder(dir)]])).values()];
}
// May a step's local file at `file` be captured or shown? Inside its
// workspace `root`, or inside a home or temporary folder under either name.
function permittedLocal(file, root) {
  if (!file) return false;
  return (!!root && platform.isInside(file, root)) || outsideFolders().some(pair => pair.some(dir => platform.isInside(file, dir)));
}
// Paths on this machine follow its own rules (C:\work or C:/work on
// Windows); a remote host's are POSIX, whatever this machine is.
const POSIX_RULES = { absolute: p => p.startsWith('/'), normalize: path.posix.normalize, resolve: path.posix.resolve, home: p => p.startsWith('~/') };
const WINDOWS_RULES = { absolute: p => path.isAbsolute(p), normalize: p => path.resolve(p), resolve: path.resolve, home: p => /^~[\\/]/.test(p) };
const pathRules = ctx => platform.IS_WIN && (ctx.host || 'local') === 'local' ? WINDOWS_RULES : POSIX_RULES;
// C:\x or C:/x: a drive on this Windows machine, not a host named C.
const windowsDrivePath = text => platform.IS_WIN && /^[A-Za-z]:[\\/]/.test(text);
function location(raw, ctx, role = 'output', evidence = 'shell-literal') {
  raw = String(raw || '');
  const rules = pathRules(ctx);
  let resolved = null, reason = '';
  if (!raw || /\x00/.test(raw) || evidence !== 'explicit-tool' && /[$`*?{}]/.test(raw)) reason = 'Dynamic path requires resolution';
  else if ((raw === '~' || rules.home(raw)) && ctx.host === 'local') resolved = path.resolve(ctx.home || os.homedir(), raw === '~' ? '' : raw.slice(2));
  else if (rules.absolute(raw)) resolved = rules.normalize(raw);
  else if (ctx.cwd && rules.absolute(ctx.cwd)) resolved = rules.resolve(ctx.cwd, raw);
  else reason = 'Execution directory is unknown';
  const host = ctx.host || 'local';
  return { id: key([host, resolved || raw, resolved ? '' : ctx.cwd || '']), host, path: resolved, raw, cwd: ctx.cwd || null, role, evidence, reason };
}
function directTargets(name, input, cwd) {
  if (!['write', 'edit', 'multiedit'].includes(String(name).toLowerCase())) return [];
  const raw = input?.path || input?.file_path;
  if (typeof raw !== 'string') return [];
  const loc = location(raw.startsWith('@') ? raw.slice(1) : raw, { host: 'local', cwd }, 'output', 'explicit-tool');
  return [{ ...loc, raw }];
}
function shellCommands(source) {
  const commands = []; let words = [], word = '', quote = '', active = false, here = [];
  const flush = () => { if (active) { words.push(word); word = ''; active = false; } };
  const finish = operator => { flush(); if (words.length) commands.push({ words, bodies: [], operator }); words = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && /["\\$`\n]/.test(source[i + 1] || '')) word += source[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (c === '\\') { active = true; if (source[i + 1] !== '\n') word += source[++i] || ''; else i++; continue; }
    if (c === '#' && !active) { while (i < source.length && source[i] !== '\n') i++; i--; continue; }
    if (c === '\n') {
      finish('\n');
      if (here.length) {
        for (const delimiter of here) {
          let body = '', ended = false;
          while (i + 1 < source.length) {
            const end = source.indexOf('\n', i + 1), stop = end < 0 ? source.length : end;
            const line = source.slice(i + 1, stop); i = stop;
            if (line.replace(/^\t+/, '') === delimiter) { ended = true; break; }
            body += line + '\n';
          }
          if (commands.length) commands.at(-1).bodies.push(body);
          if (!ended) break;
        }
        here = [];
      }
      continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    if (';&|<>'.includes(c)) {
      flush(); let op = c;
      if (source[i + 1] === c) { op += c; i++; }
      if (op === '>' && source[i + 1] === '&') {
        const fd = /^&(\d+|-)/.exec(source.slice(i + 1));
        if (fd) { words.push(op, fd[0]); i += fd[0].length; continue; }
      }
      if (op === '<<' && source[i + 1] === '-') i++;
      if (op === '<<') {
        let j = i + 1; while (/\s/.test(source[j] || '') && source[j] !== '\n') j++;
        const match = /^(?:'([^']+)'|"([^"]+)"|([\w-]+))/.exec(source.slice(j));
        if (match) { const delimiter = match[1] || match[2] || match[3]; here.push(delimiter); words.push('<<', delimiter); i = j + match[0].length - 1; }
      } else if (op === '>' || op === '>>' || op === '<') words.push(op);
      else finish(op);
      continue;
    }
    active = true; word += c;
  }
  finish(''); return commands;
}
function literalWrites(body, ctx) {
  const values = [];
  for (const re of [
    /\bPath\(\s*['"]([^'"]+)['"]\s*\)\.(?:write_text|write_bytes)\b/g,
    /\bopen\(\s*['"]([^'"]+)['"]\s*,\s*['"][wax]/g,
    /\b(?:writeFileSync|writeFile|savefig)\(\s*['"]([^'"]+)['"]/g,
    /^\s*\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)$/gm,
  ]) for (const match of body.matchAll(re)) values.push(location(match[1], ctx));
  for (const match of body.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(?:write_text|write_bytes)\s*\(/g)) values.push(location('$' + match[1], ctx, 'output', 'shell-dynamic'));
  return values;
}
function expandBraces(text) {
  const m = /^(.*?)\{([^{}]+)\}(.*)$/.exec(text);
  return m && m[2].split(',').length <= 20 ? m[2].split(',').map(p => m[1] + p + m[3]) : [text];
}
function endpoint(text, ctx, role) {
  if (windowsDrivePath(text)) return location(text, ctx, role, 'copy-command');
  const m = /^(?:([\w.-]+@)?([\w.-]+)):(.+)$/.exec(text);
  if (m) return location(m[3], { host: (m[1] || '') + m[2] + (ctx.port && ctx.port !== '22' ? ':' + ctx.port : ''), cwd: null }, role, 'copy-command');
  if (text.includes(':') && !text.startsWith('/') && !text.startsWith('./')) return location(text, { host: 'unresolved-remote', cwd: null }, role, 'copy-command');
  return location(text, ctx, role, 'copy-command');
}
function inspectShell(source, initial, depth = 0) {
  if (depth > 3 || source.length > 128000) return { locations: [], copies: [], warnings: ['Shell analysis limit reached'] };
  let ctx = { ...initial }, remoteSeen = false; const locations = [], copies = [], warnings = [];
  for (const command of shellCommands(source)) {
    let w = command.words.slice();
    while (w.length && (/^\w+=/.test(w[0]) || ['env', 'nohup', 'setsid', 'sudo', 'command'].includes(w[0]))) w.shift();
    if (w[0] === 'timeout') { w.shift(); while (w[0]?.startsWith('-')) w.shift(); w.shift(); }
    const name = path.posix.basename(w[0] || '');
    if ((w[0] || '').startsWith('(')) { ctx.cwd = null; warnings.push('Subshell directory could not be proven'); }
    if (name === 'cd') {
      const argument = w[1] === '--' ? w[2] : w[1] || '~';
      const next = argument === '-' || argument.startsWith('-') ? null : location(argument, ctx);
      if (!['|', '||', '&'].includes(command.operator)) ctx.cwd = next?.path || null;
      continue;
    }
    if (name === 'ssh') {
      remoteSeen = true;
      let i = 1, port = '', user = '';
      for (; i < w.length && w[i].startsWith('-'); i++) {
        if (w[i] === '-p') port = w[i + 1] || '';
        if (w[i] === '-l') user = w[i + 1] || '';
        if (['-p', '-i', '-F', '-J', '-l', '-o', '-S'].includes(w[i])) i++;
      }
      const destination = w[i++];
      const host = destination && (user && !destination.includes('@') ? user + '@' : '') + destination + (port && port !== '22' ? ':' + port : '');
      if (!host || !/^[\w.@:-]+$/.test(host)) { warnings.push('Unresolved SSH destination'); continue; }
      let remote = w.slice(i).join(' ');
      // An outer heredoc is stdin for the remote command, not a local script.
      if (command.bodies.length) remote += '\n' + command.bodies.join('\n') + '\n' + (w.at(-1) || '');
      const out = inspectShell(remote, { host, cwd: null }, depth + 1);
      locations.push(...out.locations); copies.push(...out.copies); warnings.push(...out.warnings); continue;
    }
    if (name === 'rsync' || name === 'scp') {
      const args = []; let port = '';
      for (let i = 1; i < w.length; i++) {
        if (name === 'scp' && w[i] === '-P') port = w[i + 1] || '';
        if (name === 'rsync' && w[i] === '-e') port = /(?:^|\s)-p\s+(\d+)/.exec(w[i + 1] || '')?.[1] || '';
        const valueFlags = name === 'rsync' ? ['-e', '--exclude', '--include', '--filter', '--files-from', '--exclude-from', '--include-from', '--rsync-path', '--port'] : ['-P', '-i', '-F', '-J', '-o', '-S'];
        if (valueFlags.includes(w[i])) { i++; continue; }
        if (w[i].startsWith('-')) continue;
        args.push(w[i]);
      }
      if (args.length >= 2) {
        const dest = endpoint(args.at(-1), { ...ctx, port }, 'copy-destination');
        for (const source of args.slice(0, -1).flatMap(expandBraces)) {
          const from = endpoint(source, { ...ctx, port }, 'copy-source');
          const directory = source.endsWith('/');
          let to = dest;
          if (!directory && args.at(-1).endsWith('/') && dest.path) to = location(path.posix.join(dest.path, path.posix.basename(from.path || from.raw)), { host: dest.host, cwd: null }, 'copy-destination', 'copy-command');
          copies.push({ from, to, directory }); locations.push(from, to);
        }
      }
      continue;
    }
    // Quoted shell invocations get their own cwd scope. Unsupported nesting
    // must not be flattened into local Python writes.
    if (['bash', 'sh', 'zsh'].includes(name) && w.includes('-c')) {
      const out = inspectShell(w[w.indexOf('-c') + 1] || '', ctx, depth + 1);
      remoteSeen ||= !!out.remote;
      locations.push(...out.locations); copies.push(...out.copies); warnings.push(...out.warnings); continue;
    }
    for (let i = 1; i < w.length; i++) if (['>', '>>'].includes(w[i]) && w[i + 1] && !/^&(?:\d+|-)$/.test(w[i + 1]) && w[i + 1] !== '/dev/null') locations.push(location(w[i + 1], ctx));
    const args = [];
    for (let i = 1; i < w.length; i++) {
      if (['>', '>>', '<', '<<'].includes(w[i])) { i++; continue; }
      if (/^\d+$/.test(w[i]) && ['>', '>>', '<'].includes(w[i + 1])) continue;
      if (!w[i].startsWith('-')) args.push(w[i]);
    }
    if (['touch', 'tee', 'rm', 'truncate'].includes(name)) for (const p of args) if (p !== '/dev/null' && !/^\d+$/.test(p)) locations.push(location(p, ctx));
    if (['cp', 'mv', 'install'].includes(name) && args.length >= 2) {
      const from = location(args.at(-2), ctx, 'copy-source'), to = location(args.at(-1), ctx, 'copy-destination');
      copies.push({ from, to, directory: args.at(-2).endsWith('/') }); locations.push(to);
      if (name === 'mv') locations.push({ ...from, role: 'output' });
    }
    if (['sed', 'perl'].includes(name) && w.some(x => /^-(?:i|pi)/.test(x))) locations.push(location(w.at(-1), ctx));
    if (['python', 'python3', 'node'].includes(name) || /(?:^|\/)python(?:\d+(?:\.\d+)*)?$/.test(w[0] || '')) {
      for (const body of command.bodies) locations.push(...literalWrites(body, ctx));
      const at = w.findIndex(x => x === '-c' || x === '-e');
      if (at >= 0) locations.push(...literalWrites(w[at + 1] || '', ctx));
    }
  }
  return { locations, copies, warnings, remote: remoteSeen };
}
function inspectTool(tool, cwd, host = 'local') {
  const input = tool.input || tool.arguments || {};
  if (['bash', 'shell'].includes(tool.name)) return inspectShell(String(input.command || input.cmd || ''), { host, cwd });
  const targets = directTargets(tool.name, input, cwd);
  return { locations: host === 'local' ? targets : targets.map(l => location(l.raw, { host, cwd }, l.role, l.evidence)), copies: [], warnings: [] };
}
function gather(tools, cwd, host = 'local') {
  const locations = new Map(), copies = [], warnings = [];
  let commandBytes = 0;
  for (const tool of tools) {
    commandBytes += String(tool.input?.command || tool.arguments?.command || '').length;
    if (commandBytes > 4 * 1024 * 1024) { warnings.push('Command analysis limit reached; narrow the selected tool group'); break; }
    const result = inspectTool(tool, cwd, host);
    for (const loc of result.locations) {
      const previous = locations.get(loc.id);
      if (!previous && locations.size >= 1000) { warnings.push('Location analysis limit reached; narrow the selected tool group'); break; }
      const item = previous || { ...loc, calls: [], evidence: loc.evidence };
      if (!item.calls.includes(tool.id)) item.calls.push(tool.id);
      if (loc.evidence === 'explicit-tool') item.evidence = loc.evidence;
      if (loc.role === 'output' || loc.role === 'copy-destination') item.role = loc.role;
      locations.set(loc.id, item);
    }
    copies.push(...result.copies.slice(0, Math.max(0, 2000 - copies.length))); warnings.push(...result.warnings);
  }
  for (const loc of locations.values()) {
    loc.localCopies = [];
    if (loc.host === 'local') continue;
    for (const copy of copies) {
      if (copy.from.host !== loc.host || copy.to.host !== 'local' || !copy.from.path || !copy.to.path || !loc.path) continue;
      if (loc.path === copy.from.path) loc.localCopies.push(copy.to.path);
      else if (copy.directory && loc.path.startsWith(copy.from.path.replace(/\/$/, '') + '/')) loc.localCopies.push(path.posix.join(copy.to.path, loc.path.slice(copy.from.path.replace(/\/$/, '').length + 1)));
    }
    loc.localCopies = [...new Set(loc.localCopies)];
  }
  return { version: VERSION, locations: [...locations.values()], copies, warnings: [...new Set(warnings)] };
}
module.exports = { VERSION, location, directTargets, inspectShell, inspectTool, gather, sensitive, outsideFolders, permittedLocal, shellCommands };

'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
let providerModule, toolsModule;
// Pi's fd, found or fetched by Pi's own tool manager: its bin folder, any
// system name (fdfind on Debian, fd.exe on Windows), else downloaded for
// this system once, as Pi does on its first start (not in offline mode).
// Without fd the provider still answers; it just cannot search the tree.
async function fdPath(piDir) {
  toolsModule ||= import(pathToFileURL(path.join(piDir, 'dist', 'utils', 'tools-manager.js')).href).catch(() => null);
  const tools = await toolsModule;
  if (!tools || typeof tools.getToolPath !== 'function') return 'fd';
  const found = tools.getToolPath('fd');
  if (found) return found;
  try { return (await tools.ensureTool('fd')) || 'fd'; } catch { return 'fd'; }
}
function decodeQuery(query) {
  if (!query.startsWith('"')) return query;
  try { return JSON.parse(query.endsWith('"') ? query : query + '"'); }
  catch { return query.slice(1).replace(/"$/, ''); }
}
function suggestion(absolute, directory, cwd) {
  // Forward slashes on every system: Pi reads them on Windows too, and the
  // ./ and ../ tests below stay one test.
  let value = path.relative(cwd, absolute).split(path.sep).join('/') || '.';
  // Explicit directory paths keep subsequent navigation rooted at cwd.
  if (directory && !value.startsWith('../') && !value.startsWith('./')) value = './' + value;
  if (directory && !value.endsWith('/')) value += '/';
  const inserted = '@' + (/[\s"\\]/.test(value) ? JSON.stringify(value) : value);
  return { label: path.basename(absolute) + (directory ? '/' : ''), description: inserted, value: inserted, directory };
}
async function completeFiles({ piDir, root, cwd, query, signal }) {
  if (signal.aborted) return [];
  const decoded = decodeQuery(query);
  const slash = decoded.lastIndexOf('/');
  if (slash >= 0) {
    const base = decoded.slice(0, slash + 1);
    const needle = decoded.slice(slash + 1).toLowerCase();
    const folder = base.startsWith('~/') ? path.join(os.homedir(), base.slice(2)) : path.resolve(cwd, base);
    const entries = [];
    // Stream the directory instead of reading an unbounded listing into memory.
    const dir = await fs.promises.opendir(folder);
    for await (const entry of dir) {
      if (signal.aborted) return [];
      if (entry.name === '.git' || !entry.name.toLowerCase().includes(needle)) continue;
      const absolute = path.join(folder, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { directory = (await fs.promises.stat(absolute)).isDirectory(); } catch { continue; }
      } else if (!directory && !entry.isFile()) continue;
      entries.push(suggestion(absolute, directory, cwd));
      entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.label.localeCompare(b.label));
      if (entries.length > 20) entries.pop();
    }
    return entries;
  }
  providerModule ||= import(pathToFileURL(createRequire(path.join(piDir, 'package.json')).resolve('@earendil-works/pi-tui')).href);
  const { CombinedAutocompleteProvider } = await providerModule;
  const provider = new CombinedAutocompleteProvider([], root, await fdPath(piDir));
  const text = '@' + query;
  const result = await provider.getSuggestions([text], 0, text.length, { signal });
  return (result?.items || []).map(item => {
    const value = decodeQuery(item.value.replace(/^@/, ''));
    return suggestion(path.resolve(root, value), item.label.endsWith('/'), cwd);
  });
}
module.exports = { completeFiles };

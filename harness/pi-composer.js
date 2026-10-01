'use strict';
// The live Pi session owns commands, argument completion, and extension
// completion wrappers. This adapter transports suggestions and the provider's
// exact edit; the browser never reimplements Pi's quoting/cursor rules.
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { commands: hostCommands } = require('./compose-commands');

const MAX_TEXT = 64 * 1024, MAX_ITEMS = 30, MAX_CLIENTS = 16;
function editorState(input) {
  const text = input.text ?? '';
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('Composer text is too large');
  const cursor = input.cursor ?? text.length;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) throw new Error('Invalid composer cursor');
  const before = text.slice(0, cursor).split('\n');
  return { text, cursor, lines: text.split('\n'), cursorLine: before.length - 1, cursorCol: before.at(-1).length };
}
function commandsOf(session) {
  const hostNames = new Set(hostCommands.map(c => c.name));
  const commands = (session.extensionRunner?.getRegisteredCommands() || []).filter(c => !hostNames.has(c.invocationName || c.name)).map(c => ({
    name: c.invocationName || c.name, description: c.description || '', source: 'extension',
    argumentHint: c.argumentHint, getArgumentCompletions: c.getArgumentCompletions,
  }));
  const names = new Set(commands.map(c => c.name));
  for (const c of session.promptTemplates || []) {
    if (!names.has(c.name)) { commands.push({ ...c, source: 'prompt' }); names.add(c.name); }
  }
  if (session.settingsManager?.getEnableSkillCommands?.() !== false) {
    for (const s of session.resourceLoader?.getSkills().skills || []) {
      const name = 'skill:' + s.name;
      if (!names.has(name)) { commands.push({ name, description: s.description || '', source: 'skill' }); names.add(name); }
    }
  }
  const match = (items, prefix) => items.filter(i => i.value.toLowerCase().includes(prefix.toLowerCase()));
  return [...hostCommands.map(c => ({ ...c, source: 'builtin',
    ...(c.name === 'model' ? { getArgumentCompletions: prefix => match((session.modelRuntime?.getAvailableSnapshot() || []).map(m => ({ value: m.provider + '/' + m.id, label: m.id, description: m.provider })), prefix) } : {}),
    ...(c.name === 'thinking' ? { getArgumentCompletions: prefix => match((session.getAvailableThinkingLevels?.() || []).map(value => ({ value, label: value })), prefix) } : {}),
  })), ...commands.filter(c => !hostNames.has(c.name))];
}
function publicCommands(session) {
  return commandsOf(session).map(c => ({ name: c.name, description: c.description || '', source: c.source, argumentHint: c.argumentHint }));
}
let providerClass;
async function loadProvider() {
  providerClass ||= (async () => {
    const dir = require('../runtime.js').piPackageDir();
    const r = createRequire(path.join(dir, 'package.json'));
    const { CombinedAutocompleteProvider } = await import(pathToFileURL(r.resolve('@earendil-works/pi-tui')).href);
    const tools = await import(pathToFileURL(path.join(dir, 'dist/utils/tools-manager.js')).href);
    // Never download a tool just because somebody typed a character. Pi's
    // installed fd is used when available; path completion works without it.
    return { CombinedAutocompleteProvider, fdPath: tools.getToolPath('fd') || null };
  })();
  try { return await providerClass; } catch (e) { providerClass = null; throw e; }
}

function createPiComposer({ session, load = loadProvider, timeoutMs = 5000, now = Date.now }) {
  const wrappers = [], clients = new Map();
  let revision = 0;
  function reset() {
    revision++;
    wrappers.length = 0;
    for (const c of clients.values()) c.controller.abort();
    clients.clear();
  }
  function addProvider(factory) {
    if (typeof factory !== 'function') throw new TypeError('Autocomplete provider must be a factory');
    wrappers.push(factory);
    revision++;
    for (const c of clients.values()) c.controller.abort();
    clients.clear();
  }
  function clientKey(input) {
    if (typeof input.clientId !== 'string' || !input.clientId || input.clientId.length > 200) throw new Error('Composer client id is required');
    return input.clientId;
  }
  async function complete(input) {
    const state = editorState(input), key = clientKey(input), generation = revision;
    clients.get(key)?.controller.abort();
    clients.delete(key);
    while (clients.size >= MAX_CLIENTS) {
      const oldest = clients.keys().next().value;
      clients.get(oldest).controller.abort(); clients.delete(oldest);
    }
    const controller = new AbortController();
    const request = { controller, at: now(), ...state, generation };
    clients.set(key, request);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const stale = () => controller.signal.aborted || clients.get(key) !== request || generation !== revision;
    const empty = () => ({ items: [], snapshot: null });
    let detach;
    const cancelled = new Promise(resolve => {
      const finish = () => resolve(empty());
      controller.signal.addEventListener('abort', finish, { once: true });
      detach = () => controller.signal.removeEventListener('abort', finish);
    });
    try {
      return await Promise.race([cancelled, (async () => {
        const { CombinedAutocompleteProvider, fdPath } = await load();
        if (stale()) return empty();
        const s = session();
        let provider = new CombinedAutocompleteProvider(commandsOf(s), s.sessionManager.getCwd(), fdPath);
        const triggers = new Set(['@', '/']);
        for (const wrap of wrappers) {
          provider = wrap(provider);
          if (!provider || typeof provider.getSuggestions !== 'function' || typeof provider.applyCompletion !== 'function') throw new Error('Invalid extension autocomplete provider');
          for (const ch of provider.triggerCharacters || []) triggers.add(ch);
        }
        const before = state.lines[state.cursorLine].slice(0, state.cursorCol);
        const token = before.match(/(?:^|\s)([^\s]*)$/)?.[1] || '';
        // Ordinary prose must not pop up the directory listing after every
        // space. Slash arguments and quoted @ paths remain live.
        if (!input.force && !before.startsWith('/') && !/(?:^|\s)@(?:"[^"\n]*|[^\s]*)$/.test(before) && ![...triggers].some(ch => token.startsWith(ch))) return empty();
        const result = await provider.getSuggestions(state.lines, state.cursorLine, state.cursorCol, { signal: controller.signal, force: !!input.force });
        if (stale() || !result?.items?.length) return empty();
        const items = result.items.slice(0, MAX_ITEMS);
        request.provider = provider; request.prefix = result.prefix; request.items = items;
        request.snapshot = randomUUID();
        return { snapshot: request.snapshot, prefix: result.prefix,
          items: items.map(c => ({ value: String(c.value), label: String(c.label), description: c.description == null ? '' : String(c.description) })) };
      })()]);
    } finally {
      clearTimeout(timer); detach();
      if (!request.snapshot && clients.get(key) === request) clients.delete(key);
    }
  }
  async function apply(input) {
    const state = editorState(input), key = clientKey(input), saved = clients.get(key);
    if (!saved || saved.controller.signal.aborted || saved.snapshot !== input.snapshot || saved.generation !== revision || now() - saved.at > 60000 ||
      saved.text !== state.text || saved.cursor !== state.cursor || !Number.isInteger(input.itemIndex) || !saved.items?.[input.itemIndex]) {
      throw new Error('Completion expired; ask for suggestions again');
    }
    clients.delete(key); // A selection is single-use and belongs to this editor.
    const edit = await saved.provider.applyCompletion(saved.lines, saved.cursorLine, saved.cursorCol, saved.items[input.itemIndex], saved.prefix);
    if (saved.generation !== revision || saved.controller.signal.aborted) throw new Error('Completion expired; ask for suggestions again');
    if (!Array.isArray(edit?.lines) || edit.lines.some(l => typeof l !== 'string') || !Number.isInteger(edit.cursorLine) || edit.cursorLine < 0 || edit.cursorLine >= edit.lines.length ||
      !Number.isInteger(edit.cursorCol) || edit.cursorCol < 0 || edit.cursorCol > edit.lines[edit.cursorLine].length) throw new Error('Provider returned an invalid completion edit');
    const text = edit.lines.join('\n');
    const cursor = edit.lines.slice(0, edit.cursorLine).reduce((n, l) => n + l.length + 1, 0) + edit.cursorCol;
    return editorState({ text, cursor });
  }
  function cancel(input) {
    const key = clientKey(input), c = clients.get(key);
    // An old HTTP connection closing must not cancel a newer query.
    if (c && (!input.snapshot || c.snapshot === input.snapshot)) { c.controller.abort(); clients.delete(key); }
    return { cancelled: true };
  }
  return { reset, addProvider, commands: () => publicCommands(session()), complete, apply, cancel };
}
module.exports = { createPiComposer, commandsOf, editorState };

'use strict';
// The compose box of a Codex conversation (design/87): the same contract
// as the Pi composer (pi-composer.js: commands, complete, apply, cancel),
// answered by Codex. "@query" is Codex's own fuzzy file search; "/" offers
// the controls Chattering has for Codex (model, reasoning, compaction,
// settings, tree), whose arguments come from Codex's model list.
const { randomUUID } = require('node:crypto');
const { commands: hostCommands } = require('./compose-commands');
const { editorState } = require('./pi-composer');

const CODEX_COMMANDS = new Set(['model', 'thinking', 'compact', 'settings', 'tree']);
const MAX_ITEMS = 30;

function createCodexComposer({ fileSearch, models, now = Date.now, timeoutMs = 5000 }) {
  const snapshots = new Map(); // client id → { snapshot, at, text, cursor, start, end, items }
  const commands = () => hostCommands.filter(c => CODEX_COMMANDS.has(c.name)).map(c => ({
    name: c.name, description: c.name === 'thinking' ? 'Choose how hard Codex thinks' : c.description,
    source: 'builtin', argumentHint: c.argumentHint,
  }));
  async function complete(input) {
    const state = editorState(input);
    const key = String(input.clientId || '');
    if (!key) throw new Error('Composer client id is required');
    snapshots.delete(key);
    const lineStart = state.text.lastIndexOf('\n', state.cursor - 1) + 1;
    const before = state.text.slice(lineStart, state.cursor);
    let items = [], start = state.cursor;
    const at = /(?:^|\s)@("?[^\s"]*)$/.exec(before);
    if (at) {
      const query = at[1].replace(/^"/, '');
      start = state.cursor - at[1].length - 1;
      const found = await Promise.race([fileSearch(query), new Promise(r => setTimeout(() => r({ files: [] }), timeoutMs))]);
      items = ((found && found.files) || []).slice(0, MAX_ITEMS).map(f => {
        const rel = String(f.path || f.file_name || '');
        const dir = f.match_type === 'directory';
        const shown = rel + (dir && !rel.endsWith('/') ? '/' : '');
        return { value: '@' + (/[\s"]/.test(shown) ? JSON.stringify(shown) : shown), label: String(f.file_name || rel) + (dir ? '/' : ''), description: shown, directory: dir };
      });
    } else if (lineStart === 0 && /^\/[^\s]*$/.test(before)) {
      const q = before.slice(1).toLowerCase();
      start = 0;
      items = commands().filter(c => c.name.includes(q)).map(c => ({ value: '/' + c.name, label: c.name, description: c.description }));
    } else if (lineStart === 0) {
      const m = /^\/(model|thinking)\s+(\S*)$/.exec(before);
      if (m) {
        start = state.cursor - m[2].length;
        const list = await models();
        if (m[1] === 'model') items = list.map(x => ({ value: x.id, label: x.displayName || x.id, description: x.description || '' }));
        else {
          const current = list.find(x => x.id === input.model) || list.find(x => x.isDefault) || list[0];
          items = ((current && current.efforts) || []).map(e => ({ value: e.effort, label: e.effort, description: e.description || '' }));
        }
        items = items.filter(i => i.value.toLowerCase().includes(m[2].toLowerCase()));
      }
    }
    if (!items.length) return { items: [], snapshot: null };
    const snapshot = randomUUID();
    snapshots.set(key, { snapshot, at: now(), text: state.text, cursor: state.cursor, start, items });
    if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
    return { snapshot, prefix: state.text.slice(start, state.cursor), items: items.map(({ value, label, description }) => ({ value, label, description })) };
  }
  function apply(input) {
    const state = editorState(input);
    const key = String(input.clientId || '');
    const saved = snapshots.get(key);
    if (!saved || saved.snapshot !== input.snapshot || saved.text !== state.text || saved.cursor !== state.cursor || now() - saved.at > 60000
      || !Number.isInteger(input.itemIndex) || !saved.items[input.itemIndex]) throw new Error('Completion expired; ask for suggestions again');
    snapshots.delete(key);
    const item = saved.items[input.itemIndex];
    // A command or a file gets a space after it; a folder does not, so the
    // search can go on inside it.
    const insert = item.value + (item.directory ? '' : ' ');
    const text = state.text.slice(0, saved.start) + insert + state.text.slice(state.cursor).replace(/^ /, '');
    return { text, cursor: saved.start + insert.length };
  }
  function cancel(input) { snapshots.delete(String(input.clientId || '')); return { cancelled: true }; }
  return { commands, complete, apply, cancel };
}

// Codex's model list, reduced to what menus need.
function modelsOfList(list) {
  return ((list && list.data) || []).filter(m => !m.hidden).map(m => ({
    id: m.id || m.model, displayName: m.displayName || m.id, description: m.description || '', isDefault: !!m.isDefault,
    defaultEffort: m.defaultReasoningEffort || null, images: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : true,
    efforts: (m.supportedReasoningEfforts || []).map(e => ({ effort: e.reasoningEffort, description: e.description || '' })),
  }));
}

module.exports = { createCodexComposer, modelsOfList };

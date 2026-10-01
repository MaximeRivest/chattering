// Pi terminal built-ins have no session.prompt handler. These commands have
// actual HTML controls (or a hosted SDK operation), not synthetic model prompts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ComposeCommands = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const commands = [
    { name: 'model', description: 'Choose the model for the next reply', action: 'model', argumentHint: '[provider/model]' },
    { name: 'thinking', description: 'Choose the reasoning level', action: 'thinking', argumentHint: '[level]' },
    { name: 'settings', description: 'Open Chattering settings', action: 'settings' },
    { name: 'tree', description: 'Open this conversation’s branches', action: 'tree' },
    { name: 'compact', description: 'Summarize older context with Pi', action: 'compact', argumentHint: '[instructions]' },
    { name: 'reload', description: 'Reload Pi extensions, skills and prompts', action: 'runtime' },
  ];
  function parse(text) {
    const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
    const c = m && commands.find(c => c.name === m[1]);
    return c ? { ...c, args: m[2] || '' } : null;
  }
  return { commands, parse };
});

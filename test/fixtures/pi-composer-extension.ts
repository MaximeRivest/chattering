export default function(pi: any) {
  pi.registerCommand('composer-choice', {
    description: 'Choose a fixture value',
    getArgumentCompletions: async (prefix: string) => [{ value: prefix + 'blue', label: 'Blue', description: 'from the actual extension' }],
    handler: async (args: string, ctx: any) => { ctx.ui.notify('chosen:' + args); },
  });
  pi.registerCommand('composer-reload', { handler: async (_args: string, ctx: any) => { await ctx.reload(); } });
  pi.on('session_start', (_event: any, ctx: any) => {
    ctx.ui.addAutocompleteProvider((base: any) => ({
      triggerCharacters: ['#'],
      getSuggestions: async (lines: string[], row: number, col: number, options: any) => {
        if (lines[row].slice(0, col).startsWith('#')) return { prefix: lines[row].slice(0, col), items: [{ value: 'cell-seven', label: 'Cell seven', description: ctx.ui.getEditorText(), privateCell: 7 }] };
        return base.getSuggestions(lines, row, col, options);
      },
      applyCompletion: (lines: string[], row: number, col: number, item: any, prefix: string) => {
        if (item.privateCell === 7) return { lines: ['cell:7'], cursorLine: 0, cursorCol: 5 };
        return base.applyCompletion(lines, row, col, item, prefix);
      },
    }));
  });
}

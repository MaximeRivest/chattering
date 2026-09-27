// AI commands in documents: what each one asks a model, shared by the
// server (which builds the prompt) and the page (which lists the commands
// in mrmd's command box).
//
// The editor (mrmd-document's `ai` option, document-ai.js) owns the surface:
// where a command acts, the suggestion beside the text, accept and discard.
// Chattering owns the rest: this catalog, the model (Chattering's own, the
// one in settings → model), the call (a no-session, tool-less `pi` run),
// and the provenance of an accepted edit.
//
// The server answers only commands listed here; a request never carries its
// own prompt, so the route is not a general model proxy. The one free-form
// field is the instruction of the `edit` command, capped in length.
//
// Commands exist on surfaces, the kinds of file they suit (surfaceOf):
// 'document' (Markdown, with prose and code cells), 'source' (a code or
// config file) and 'text' (plain prose: .txt, .rst, a README without
// extension…). The page lists a surface's commands; the server refuses a
// command on a file of another surface.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatteringAiCommands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // What goes to the model, at most. Past these, the document is cut
  // around the target (with a marker saying so), never the target itself.
  const LIMITS = Object.freeze({ document: 60000, target: 20000, before: 6000, after: 2000, block: 20000, instruction: 2000 });

  const SURFACES = Object.freeze(['document', 'source', 'text']);
  // The Markdown family opens as a document (server DOCUMENT_EXT, filesmode MD_EXT).
  const DOCUMENT_EXT = /\.(md|markdown|qmd|rmd|mdx)$/i;
  // Prose without markup the editor renders: prose commands, not code ones.
  const TEXT_EXT = /\.(txt|text|rst|rest|tex|latex|ltx|org|adoc|asciidoc|textile|wiki|mediawiki|srt|vtt)$/i;
  const TEXT_NAMES = /^(readme|changelog|changes|news|history|notes|todo|authors|contributors|contributing|license|licence|copying|install|thanks|faq)$/i;

  /** The surface of a file: 'document', 'text' or 'source'. */
  function surfaceOf(filePath) {
    const name = String(filePath || '').split(/[\\/]/).pop();
    if (DOCUMENT_EXT.test(name)) return 'document';
    if (TEXT_EXT.test(name) || TEXT_NAMES.test(name)) return 'text';
    return 'source';
  }
  const PROSE_SURFACES = ['document', 'text'];
  const CODE_SURFACES = ['document', 'source'];

  // The reply contract every task ends with, by kind.
  const REPLY = {
    replace: 'Reply with the new text for TARGET only — no explanation, no quotation marks, no code fence around it.',
    insert: 'Reply with the text to insert at the cursor only — no explanation, no quotation marks, no code fence around it, and nothing that is already before the cursor. Begin with a space or a line break if the text needs one.',
  };

  // thinking: the pi thinking level of the call. Quick prose fixes need
  // none; code and free-form edits get a little.
  const COMMANDS = [
    { id: 'grammar', label: 'Fix grammar and spelling', hint: 'minimal changes', keywords: ['spelling', 'typos', 'punctuation', 'correct'],
      scope: 'prose', target: 'selection-or-block', kind: 'replace', thinking: 'off', surfaces: PROSE_SURFACES,
      task: 'Correct the grammar, spelling and punctuation of TARGET. Change as little as possible: keep the wording, the tone, the formatting (Markdown or other markup), the line breaks and the technical terms. If nothing needs fixing, reply with TARGET unchanged.' },
    { id: 'transcription', label: 'Fix dictation', hint: 'speech-to-text errors', keywords: ['speech', 'voice', 'transcript', 'dictated'],
      scope: 'prose', target: 'selection-or-block', kind: 'replace', thinking: 'off', surfaces: PROSE_SURFACES,
      task: 'TARGET was dictated with speech-to-text. Fix misheard words (the document shows the names and terms in use), punctuation and capitalization. Keep the speaker\u2019s meaning and wording otherwise: do not rephrase, shorten or summarize.' },
    { id: 'sentence', label: 'Finish the sentence', hint: 'at the cursor', keywords: ['complete', 'continue', 'autocomplete'],
      scope: 'prose', target: 'cursor', kind: 'insert', thinking: 'off', surfaces: PROSE_SURFACES,
      task: 'Continue the text at the cursor to the end of the current sentence, in the document\u2019s voice and language. Stop at the end of that sentence.' },
    { id: 'paragraph', label: 'Finish the paragraph', hint: 'at the cursor', keywords: ['complete', 'continue', 'write'],
      scope: 'prose', target: 'cursor', kind: 'insert', thinking: 'off', surfaces: PROSE_SURFACES,
      task: 'Continue the text at the cursor to the end of the current paragraph, in the document\u2019s voice and language, bringing its thought to a close. Do not start a new paragraph.' },
    { id: 'markdown', label: 'Tidy the Markdown', hint: 'formatting only', keywords: ['format', 'clean', 'lists', 'headings'],
      scope: 'prose', target: 'selection-or-block', kind: 'replace', thinking: 'off', surfaces: ['document'],
      task: 'Fix the Markdown formatting of TARGET: list markers and indentation, emphasis, headings, links, tables, spacing. Do not change a single word.' },
    { id: 'code-line', label: 'Finish this line', hint: 'at the cursor', keywords: ['complete', 'continue'],
      scope: 'code', target: 'cursor', kind: 'insert', thinking: 'low', surfaces: CODE_SURFACES,
      task: 'Complete the current line of {language} code at the cursor. Reply with the rest of that line only: no line break, nothing after it.' },
    { id: 'code-cell', label: 'Finish this cell', hint: 'at the cursor', keywords: ['complete', 'continue', 'function', 'block'],
      scope: 'code', target: 'cursor', kind: 'insert', thinking: 'low', surfaces: ['document'],
      task: 'Continue the {language} code at the cursor to finish the current function, block or cell, following the style of the code around it and of the other cells in the document.' },
    { id: 'code-block', label: 'Finish this block', hint: 'at the cursor', keywords: ['complete', 'continue', 'function', 'method'],
      scope: 'code', target: 'cursor', kind: 'insert', thinking: 'low', surfaces: ['source'],
      task: 'Continue the {language} code at the cursor to finish the current function or block, following the style and the conventions of the rest of the file.' },
    { id: 'comments', label: 'Document the code', hint: 'docstrings, comments', keywords: ['docstring', 'comments', 'explain'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'low', surfaces: CODE_SURFACES,
      task: 'Add docstrings and comments to the {language} code in TARGET where they help a reader understand why and how. Do not change what the code does, its names, or its formatting.' },
    { id: 'types', label: 'Add type hints', hint: 'annotations', keywords: ['types', 'annotations', 'typing'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'low', surfaces: CODE_SURFACES,
      task: 'Add type annotations to the {language} code in TARGET where the language supports them, using the types the code actually works with. Do not change what the code does, its names, or its formatting otherwise.' },
    { id: 'names', label: 'Improve names', hint: 'clearer identifiers', keywords: ['rename', 'variables', 'identifiers'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'low', surfaces: CODE_SURFACES,
      task: 'Give clearer names to the variables, functions and parameters that TARGET defines. A name used anywhere outside TARGET (elsewhere in the file or document, or by other code) must keep its name: renaming it here alone would break the code that uses it. Change nothing else.' },
    { id: 'format', label: 'Format the code', hint: 'standard style', keywords: ['format', 'style', 'indent', 'lint'],
      scope: 'code', target: 'selection-or-block', kind: 'replace', thinking: 'off', surfaces: CODE_SURFACES,
      task: 'Reformat the {language} code in TARGET the way its standard formatter would. Do not change what the code does or its names.' },
    { id: 'edit', label: 'Change it', hint: 'as you describe', keywords: [],
      scope: 'any', target: 'selection-or-block', kind: 'replace', instruction: true, thinking: 'low', surfaces: SURFACES,
      task: 'Rewrite TARGET as the person asks: {instruction}\nChange only what this request needs; keep everything else as it is (formatting, style, language).' },
  ];

  const byId = new Map(COMMANDS.map(c => [c.id, c]));

  /** A surface's commands as mrmd's `ai.commands` option wants them (no prompts). */
  function publicCommands(surface = 'document') {
    return COMMANDS.filter(c => c.surfaces.includes(surface)).map(({ task, thinking, surfaces, ...shown }) => shown);
  }

  function commandById(id) {
    return byId.get(String(id || '')) || null;
  }

  const str = v => (typeof v === 'string' ? v : '');
  const int = v => (Number.isInteger(v) && v >= 0 ? v : null);

  /**
   * Check a request from the page (mrmd's request, see document-ai.js) and
   * keep only what the prompt uses. `surface`: the file's (surfaceOf), as
   * the server sees it. Returns {error} or {command, request}.
   */
  function validateRequest(body, surface = 'document') {
    const command = commandById(body && body.command);
    if (!command) return { error: 'unknown AI command' };
    if (!command.surfaces.includes(surface)) return { error: 'this command does not apply to this kind of file' };
    const r = body.request && typeof body.request === 'object' ? body.request : null;
    if (!r) return { error: 'request required' };
    const document = str(r.document);
    const target = r.target && typeof r.target === 'object' ? r.target : {};
    const from = int(target.from), to = int(target.to);
    if (from === null || to === null || to < from || to > document.length) return { error: 'the target is not in the document' };
    // The target must be the document's own text at that place: the prompt
    // shows it in context, and a mismatch means the request is inconsistent.
    if (document.slice(from, to) !== str(target.text)) return { error: 'the target does not match the document' };
    if (command.kind === 'replace' && !str(target.text).trim()) return { error: 'there is no text to change' };
    if (to - from > LIMITS.target) return { error: `the selection is too long for an AI command (over ${LIMITS.target} characters)` };
    const instruction = str(r.instruction).trim();
    if (command.instruction && !instruction) return { error: 'say what to change' };
    if (instruction.length > LIMITS.instruction) return { error: `the instruction is too long (over ${LIMITS.instruction} characters)` };
    const block = r.block && typeof r.block === 'object' ? r.block : {};
    const scope = r.scope === 'code' ? 'code' : 'prose';
    if (command.scope !== 'any' && command.scope !== scope) return { error: 'this command does not apply here' };
    return {
      command,
      request: {
        surface, scope, from, to, document, instruction: command.instruction ? instruction : '',
        target: document.slice(from, to),
        language: scope === 'code' ? (str(block.language).replace(/[^\w+#.-]/g, '').slice(0, 40) || 'text') : '',
        block: str(block.text).slice(0, LIMITS.block),
      },
    };
  }

  // A tag no document text can close: the document could contain
  // "</target>", but not a random suffix it never saw.
  function fence(name, nonce, body, attrs = '') {
    return `<${name}-${nonce}${attrs}>\n${body}\n</${name}-${nonce}>`;
  }

  /** The document, cut around [from, to) to fit `limit`, with markers where text was left out. */
  function documentWindow(document, from, to, limit) {
    if (document.length <= limit) return document;
    const room = Math.max(0, limit - (to - from));
    const start = Math.max(0, from - Math.floor(room * 0.7));
    const end = Math.min(document.length, to + (room - (from - start)));
    return (start > 0 ? `[… ${start} characters not shown …]\n` : '')
      + document.slice(start, end)
      + (end < document.length ? `\n[… ${document.length - end} characters not shown …]` : '');
  }

  /**
   * The model call for a validated request: `input` goes to the model as an
   * attached file, `prompt` as the message.
   * @param {object} command  from commandById
   * @param {object} request  from validateRequest
   * @param {{path: string, nonce: string}} opts  the document's path as the person sees it; a fresh random nonce
   */
  function buildPrompt(command, request, { path = '', nonce }) {
    if (!/^[0-9a-f]{8,}$/.test(String(nonce || ''))) throw new Error('buildPrompt needs a random hex nonce');
    const { document, from, to, scope, language, block, target, instruction, surface = 'document' } = request;
    const parts = [
      fence('document', nonce, documentWindow(document, from, to, LIMITS.document), path ? ` path="${path.replace(/"/g, '')}"` : ''),
      fence('block', nonce, block, scope === 'code' ? ` kind="code" language="${language}"` : ' kind="prose"'),
    ];
    if (command.kind === 'insert') {
      parts.push(fence('before-cursor', nonce, document.slice(Math.max(0, from - LIMITS.before), from)));
      parts.push(fence('after-cursor', nonce, document.slice(to, to + LIMITS.after)));
    } else {
      parts.push(fence('target', nonce, target));
    }
    const input = parts.join('\n\n') + '\n';
    const where = command.kind === 'insert'
      ? `The cursor is between before-cursor-${nonce} and after-cursor-${nonce}, inside block-${nonce} of document-${nonce}.`
      : `TARGET is the text in target-${nonce}; it sits inside block-${nonce} of document-${nonce}.`;
    // Replacer functions: an instruction may contain "$&" or "$1", which a
    // replacement string would expand.
    const task = command.task
      .replace(/\{language\}/g, () => language || 'text')
      .replace(/\{instruction\}/g, () => `\u201c${instruction}\u201d`);
    // What the file is, in the words a model knows. A source file's
    // language is the code's (the editor names it from the file name).
    const what = surface === 'source' ? `a ${language || 'source'} file` : surface === 'text' ? 'a plain-text file' : 'a Markdown document';
    const prompt = [
      `You are editing part of ${what} for the person who wrote it. The attached file holds the ${surface === 'document' ? 'document' : 'file'} and the part to work on.`,
      where,
      task,
      REPLY[command.kind],
    ].join('\n\n');
    return { input, prompt };
  }

  /**
   * The same call as the inputs of the command's AI program (ai-programs.js,
   * `doc_<id>`): the template there writes them into the fenced message
   * buildPrompt writes here.
   */
  function programInputs(command, request, { path = '', nonce }) {
    if (!/^[0-9a-f]{8,}$/.test(String(nonce || ''))) throw new Error('programInputs needs a random hex nonce');
    const { document, from, to, scope, language, block, target, instruction, surface = 'document' } = request;
    const what = surface === 'source' ? `a ${language || 'source'} file` : surface === 'text' ? 'a plain-text file' : 'a Markdown document';
    const out = {
      what, nonce, path: String(path).replace(/"/g, ''), document: documentWindow(document, from, to, LIMITS.document),
      block_kind: scope === 'code' ? `kind="code" language="${language}"` : 'kind="prose"', block,
      language: language || 'text', request: command.instruction ? `\u201c${instruction}\u201d` : '',
    };
    if (command.kind === 'insert') {
      out.before_cursor = document.slice(Math.max(0, from - LIMITS.before), from);
      out.after_cursor = document.slice(to, to + LIMITS.after);
    } else out.target = target;
    return out;
  }

  return { LIMITS, SURFACES, COMMANDS, REPLY, surfaceOf, publicCommands, commandById, validateRequest, buildPrompt, programInputs, documentWindow };
});

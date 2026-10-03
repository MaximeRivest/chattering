'use strict';
/* How a Markdown document looks in the editor, for every page that shows one
   (design/92): Chattering's own file view and the page a shared link opens.
   One source, so the two cannot drift apart: the editor's theme (every
   value a var() into tokens.css), and ```mermaid diagrams drawn with the
   vendored library. The CSS that goes with it is document-editor.css.

   Moved here from app.html, unchanged. */
(function () {
  const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Resolve any CSS color to its luminance (tokens are hsl/hex strings).
  function luma(c) {
  const el = document.createElement('div');
  el.style.color = c;
  document.body.appendChild(el);
  const rgb = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) || [0, 0, 0]).map(Number);
  el.remove();
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  }
  const isDark = () => luma(token('--bg')) < 0.5;

  // The editor's theme, built from the design tokens. isDark: the page's
  // ground is dark; binary: the e-ink theme (no half-tones).
  function editorTheme({ isDark = false, binary = false } = {}) {
  return {
    name: 'chattering',
    isDark,

    // editor surface
    '--editor-background': 'var(--bg)',
    '--editor-foreground': 'var(--text)',
    '--editor-cursor': 'var(--accent)',
    '--editor-selection': 'color-mix(in srgb, var(--accent) 30%, var(--bg))',
    '--editor-selection-match': 'color-mix(in srgb, var(--accent) 18%, var(--bg))',
    '--editor-active-line': 'transparent',
    '--editor-gutter': 'var(--bg)',
    '--editor-line-number': 'var(--text-faint)',
    '--editor-line-number-active': 'var(--text-dim)',
    '--editor-matching-bracket': 'color-mix(in srgb, var(--accent) 25%, var(--bg))',
    // The file's text: its font (a document's is the device's choice,
    // a code file's stays monospace) and size, scaled on this device
    // (live-file.js "how files look").
    '--editor-font-family': 'var(--editor-text-font, var(--font-mono))',
    '--editor-font-size': 'calc(var(--fs-title) * var(--file-text-scale, 1))',
    '--editor-line-height': '1.65',

    // widgets (panels, tooltips, fold placeholders)
    '--widget-font-mono': 'var(--font-mono)',
    '--widget-font-sans': 'var(--font)',
    '--widget-border-radius': 'var(--r-sm)',
    '--widget-surface': 'var(--surface-1)',
    '--widget-surface-hover': 'var(--surface-2)',
    '--widget-surface-elevated': 'var(--surface-2)',
    '--widget-surface-inset': 'var(--surface-1)',
    '--widget-border': 'var(--border)',
    '--widget-border-accent': 'var(--accent)',
    '--widget-border-focus': 'var(--accent-strong)',
    '--widget-text': 'var(--text)',
    '--widget-text-muted': 'var(--text-dim)',
    '--widget-text-accent': 'var(--accent)',
    '--widget-success': 'var(--success)',
    '--widget-warning': 'var(--warn)',
    '--widget-error': 'var(--danger)',
    '--widget-info': 'var(--blue)',

    // syntax — the app's sx-* palette
    '--syntax-keyword': 'var(--accent)',
    '--syntax-control': 'var(--accent)',
    '--syntax-string': 'var(--cyan)',
    '--syntax-number': 'var(--magenta)',
    '--syntax-comment': 'var(--text-faint)',
    '--syntax-function': 'var(--blue)',
    '--syntax-variable': 'var(--text)',
    '--syntax-variable-special': 'var(--accent)',
    '--syntax-property': 'var(--text)',
    '--syntax-operator': 'var(--text-dim)',
    '--syntax-punctuation': 'var(--text-dim)',
    '--syntax-type': 'var(--yellow)',
    '--syntax-class': 'var(--yellow)',
    '--syntax-constant': 'var(--magenta)',
    '--syntax-parameter': 'var(--text)',
    '--syntax-regexp': 'var(--red)',
    '--syntax-escape': 'var(--yellow)',
    '--syntax-tag': 'var(--accent)',
    '--syntax-attribute': 'var(--yellow)',
    '--syntax-attribute-value': 'var(--cyan)',
    '--syntax-heading': 'var(--text)',
    '--syntax-link': 'var(--cyan)',
    '--syntax-link-text': 'var(--cyan)',
    '--syntax-emphasis': 'var(--text)',
    '--syntax-strong': 'var(--text)',
    '--syntax-strikethrough': 'var(--text-faint)',
    '--syntax-quote': 'var(--text-dim)',
    // inline code follows the conversation voice: quiet, dim, italic
    '--syntax-code': 'var(--text-dim)',
    '--syntax-code-background': 'var(--surface-2)',
    '--syntax-meta': 'var(--text-dim)',
    '--syntax-inserted': 'var(--green)',
    '--syntax-deleted': 'var(--red)',
    '--syntax-changed': 'var(--blue)',

    // rendered markdown — mirrors the conversation .md styles: flat
    // heading sizes with a rule under h1/h2 (rule via .cm-md-h*-line CSS),
    // quiet italic inline code, square corners, thin blockquote bar.
    '--md-heading-1-size': '1.15em',
    '--md-heading-2-size': '1.15em',
    '--md-heading-3-size': '1em',
    '--md-heading-4-size': '1em',
    '--md-heading-5-size': '1em',
    '--md-heading-6-size': '1em',
    '--md-heading-weight': '700',
    '--md-heading-margin-top': '0',
    '--md-heading-color': 'var(--text)',
    '--md-marker-color': 'var(--text-faint)',
    '--md-marker-font': 'var(--font)',
    '--md-link-color': 'var(--cyan)',
    '--md-link-decoration': 'underline',
    '--md-code-background': 'transparent',
    '--md-code-color': 'var(--text-dim)',
    '--md-code-padding': '0',
    '--md-code-radius': '0',
    '--md-blockquote-border': 'var(--border-strong)',
    '--md-blockquote-border-width': '2px',
    '--md-blockquote-padding': '10px',
    '--md-blockquote-color': 'var(--text-dim)',
    '--md-list-marker-color': 'var(--text-faint)',
    '--md-hr-color': 'var(--border)',
    '--md-table-border': 'var(--border)',
    '--md-table-header-bg': 'var(--surface-1)',
    '--md-checkbox-color': 'var(--accent)',
    '--md-alert-note-color': 'var(--blue)',
    '--md-alert-tip-color': 'var(--green)',
    '--md-alert-important-color': 'var(--magenta)',
    '--md-alert-warning-color': 'var(--warn)',
    '--md-alert-caution-color': 'var(--danger)',

    // The selection overlay paints ABOVE line fills (code blocks) — a
    // translucent accent keeps text readable while staying unmissable.
    '--mrmd-selection-overlay': binary ? 'var(--overlay)' : 'color-mix(in srgb, var(--accent) 32%, transparent)',

    // popups the bundle may open (menus, dialogs)
    '--mrmd-ui-font': 'var(--font)',
    '--mrmd-panel-bg': 'var(--surface-2)',
    '--mrmd-popup-bg': 'var(--surface-2)',
    '--mrmd-bg': 'var(--bg)',
    '--mrmd-fg': 'var(--text)',
    '--mrmd-fg-muted': 'var(--text-dim)',
    '--mrmd-border': 'var(--border)',
    '--mrmd-hover-bg': 'var(--surface-2)',
    '--mrmd-active-bg': 'var(--surface-3)',
    '--mrmd-selection-bg': 'color-mix(in srgb, var(--accent) 30%, var(--bg))',
    '--mrmd-accent': 'var(--accent)',
    '--mrmd-accent-hover': 'var(--accent-strong)',
    '--mrmd-success': 'var(--success)',
    '--mrmd-warning': 'var(--warn)',
    '--mrmd-error': 'var(--danger)',
    '--mrmd-shadow-md': 'var(--shadow)',
    '--mrmd-shadow-lg': 'var(--shadow)',
    '--mrmd-shadow-xl': 'var(--shadow)',
    '--mrmd-menu-border': 'var(--border-strong)',
    '--mrmd-dialog-border': 'var(--border-strong)',
    '--mrmd-input-border': 'var(--border)',
    '--mrmd-button-bg': 'var(--surface-2)',
    '--mrmd-button-border': 'var(--border)',
    '--mrmd-button-hover': 'var(--surface-3)',
    '--mrmd-button-active': 'var(--surface-3)',

    // binary e-ink: no half-tones — selection and brackets go solid
    ...(binary ? {
      '--editor-selection': 'var(--text)',
      '--editor-selection-match': 'transparent',
      '--editor-matching-bracket': 'transparent',
      '--mrmd-selection-bg': 'var(--text)',
      // the AI spark at rest: faint is a half-tone; solid, like the rest
      '--mrmd-ai-spark-rest': '1',
      // changes under review: no tinted grounds; bars, strike-through and underline say it
      '--mrmd-review-inserted': 'transparent',
      '--mrmd-review-deleted': 'transparent',
    } : {}),
  };
  }

  // ---- mermaid ----
  let mermaidSrc = '/vendor/mermaid.min.js';
  let mermaidLoad = null;
  function mermaidConfig() {
  const tk = token;
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      darkMode: luma(tk('--bg')) < 0.5,
      background: tk('--bg'),
      fontFamily: tk('--font') || 'ui-monospace, monospace',
      fontSize: '13px',
      // nodes and shapes
      primaryColor: tk('--surface-2'),
      primaryTextColor: tk('--text'),
      primaryBorderColor: tk('--border-strong'),
      secondaryColor: tk('--surface-1'),
      secondaryTextColor: tk('--text'),
      secondaryBorderColor: tk('--border'),
      tertiaryColor: tk('--bg'),
      tertiaryTextColor: tk('--text-dim'),
      tertiaryBorderColor: tk('--border'),
      mainBkg: tk('--surface-2'),
      nodeBorder: tk('--border-strong'),
      clusterBkg: tk('--surface-1'),
      clusterBorder: tk('--border'),
      // text and edges
      textColor: tk('--text'),
      titleColor: tk('--text'),
      lineColor: tk('--text-dim'),
      edgeLabelBackground: tk('--bg'),
      // sequence diagrams
      actorBkg: tk('--surface-2'),
      actorBorder: tk('--border-strong'),
      actorTextColor: tk('--text'),
      actorLineColor: tk('--border-strong'),
      signalColor: tk('--text-dim'),
      signalTextColor: tk('--text-dim'),
      labelBoxBkgColor: tk('--surface-1'),
      labelBoxBorderColor: tk('--border-strong'),
      labelTextColor: tk('--text'),
      loopTextColor: tk('--text-dim'),
      activationBkgColor: tk('--surface-3') || tk('--surface-2'),
      activationBorderColor: tk('--accent'),
      // notes
      noteBkgColor: tk('--surface-1'),
      noteTextColor: tk('--text-dim'),
      noteBorderColor: tk('--border-strong'),
      // states of error and emphasis
      errorBkgColor: tk('--danger'),
      errorTextColor: tk('--bg'),
      // pies and sections lean on the terminal palette
      pie1: tk('--accent'), pie2: tk('--cyan'), pie3: tk('--yellow'),
      pie4: tk('--magenta'), pie5: tk('--blue'), pie6: tk('--red'),
      pieTitleTextColor: tk('--text'),
      pieSectionTextColor: tk('--text'),
      pieLegendTextColor: tk('--text-dim'),
    },
  };
  }
  function loadMermaid() {
    if (window.mermaid) return Promise.resolve();
    if (!mermaidLoad) {
      const load = new Promise((ok, bad) => {
        const s = document.createElement('script');
        s.src = mermaidSrc;
        s.onload = ok;
        s.onerror = () => bad(new Error('mermaid.min.js failed to load'));
        document.head.appendChild(s);
      }).then(() => window.mermaid.initialize(mermaidConfig()));
      // A failed load (or a failed initialize) is forgotten, so the next
      // diagram tries again instead of inheriting a rejection for the session.
      load.catch(() => { if (mermaidLoad === load) mermaidLoad = null; });
      mermaidLoad = load;
    }
    return mermaidLoad;
  }
  let seq = 0;
  // One diagram, drawn: the figure element every mermaid surface shares.
  // Throws with mermaid's own message; the element mermaid leaves in the
  // page on a parse error is removed first.
  async function diagramNode(source) {
    await loadMermaid();
    const id = 'mmd' + (++seq);
    try {
      const { svg } = await window.mermaid.render(id, source);
      const fig = document.createElement('div');
      fig.className = 'mmd-fig';
      fig.innerHTML = svg;
      return fig;
    } catch (e) {
      const stray = document.getElementById(id) || document.getElementById('d' + id);
      if (stray) stray.remove();
      throw e;
    }
  }
  // For the editor: one object (the bundle caches drawings per render function).
  const diagrams = { languages: ['mermaid'], render: (lang, source) => diagramNode(source) };

  window.DocumentLook = {
    editorTheme, isDark, luma, mermaidConfig, loadMermaid, diagramNode, diagrams,
    configure({ mermaid } = {}) { if (mermaid) mermaidSrc = mermaid; },
  };
})();

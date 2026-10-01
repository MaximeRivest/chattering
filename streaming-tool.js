(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StreamingTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Read JSON strings without guessing unfinished escape sequences. Quoted
  // content is consumed as one token, never searched for apparent field names.
  function stringAt(s, start) {
    let text = '', i = start + 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '"') return { text, end: i + 1, complete: true };
      if (c !== '\\') { text += c; continue; }
      if (++i >= s.length) break;
      const esc = s[i];
      if (esc === 'u') {
        const hex = s.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(hex)) break;
        text += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else {
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        if (!(esc in escapes)) break;
        text += escapes[esc];
      }
    }
    // Do not briefly paint half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { text, end: s.length, complete: false };
  }
  function preview(raw, name) {
    const fields = [];
    for (let i = 0; i < raw.length;) {
      if (raw[i] !== '"') { i++; continue; }
      const key = stringAt(raw, i); i = key.end;
      if (!key.complete) break;
      while (/\s/.test(raw[i] || '') && i < raw.length) i++;
      if (raw[i] !== ':') continue;
      i++; while (/\s/.test(raw[i] || '') && i < raw.length) i++;
      if (raw[i] !== '"') continue;
      const value = stringAt(raw, i); i = value.end;
      fields.push([key.text, value.text]);
    }
    const path = fields.find(([k]) => k === 'path' || k === 'file_path')?.[1] || '';
    const edits = [];
    for (const [key, value] of fields) {
      if (key === 'oldText' || key === 'old_string') edits.push({ old: value });
      if (key === 'newText' || key === 'new_string') {
        if (!edits.length || edits[edits.length - 1].new !== undefined) edits.push({});
        edits[edits.length - 1].new = value;
      }
    }
    const content = fields.find(([k]) => k === 'content')?.[1];
    const command = fields.find(([k]) => k === 'command')?.[1];
    const kind = name === 'bash' || ((!name || name === '?') && command !== undefined) ? 'bash'
      : edits.length ? 'edit' : content !== undefined ? 'write' : /^(edit|write)$/.test(name) ? name : null;
    return { path, edits, content, command, kind };
  }
  function render(host, block, _setText, diff, { expanded = false } = {}) {
    const setText = (node, text) => {
      if (node._streamText === text) return;
      const previous = node._streamText || '';
      if (node.firstChild?.nodeType === 3 && text.startsWith(previous)) node.firstChild.appendData(text.slice(previous.length));
      else node.textContent = text;
      node._streamText = text;
    };
    const raw = block.rawArgs ?? block.args ?? '';
    const p = preview(raw, block.name);
    if (!host.firstChild) {
      host.innerHTML = '<div class="st-title"></div><div class="st-parts"></div><div class="st-limit"></div><details><summary>Raw arguments</summary><pre class="ls-args"></pre></details>';
      host.querySelector('details').open = expanded;
    }
    setText(host.querySelector('.ls-args'), raw);
    const details = host.querySelector('details');
    if (!expanded && !p.kind && !host.dataset.recognized) details.open = true;
    if (p.kind && !host.dataset.recognized) { if (!expanded) details.open = false; host.dataset.recognized = '1'; }
    host.classList.toggle('st-shell', p.kind === 'bash');
    const status = block.phase === 'done' ? block.error ? 'Failed' : p.kind === 'bash' ? 'Finished' : 'Applied'
      : block.phase === 'running' ? p.kind === 'bash' ? 'Running…' : 'Applying…'
      : block.phase === 'ready' ? 'Queued' : 'Preparing…';
    setText(host.querySelector('.st-title'), p.kind === 'bash' ? `Shell command · ${status}`
      : p.kind ? `${p.kind === 'edit' ? 'Editing' : 'Writing'} ${p.path || '…'} · ${status}` : '');
    setText(host.querySelector('.st-limit'), block.argsTruncated ? 'Preview limit reached (262,144 characters). The actual tool call is not truncated.' : '');
    const parts = host.querySelector('.st-parts');
    const chunks = p.kind === 'bash' ? [{ content: p.command ?? (block.rawArgs === undefined && !raw.trimStart().startsWith('{') ? raw : '') }]
      : p.kind === 'write' ? [{ content: p.content || '' }] : p.edits;
    chunks.forEach((chunk, i) => {
      let section = parts.children[i];
      if (!section) {
        section = document.createElement('section');
        section.innerHTML = '<div class="st-label"></div><pre class="st-old"></pre><div class="st-new-label"></div><pre class="st-new"></pre><pre class="st-diff" hidden></pre>';
        parts.appendChild(section);
      }
      const renderKey = JSON.stringify([chunk, block.phase, !!block.argsTruncated]);
      if (section._renderKey === renderKey) return;
      section._renderKey = renderKey;
      const old = section.querySelector('.st-old'), next = section.querySelector('.st-new');
      if (section.querySelector('.st-diff').hidden === false) return;
      setText(section.querySelector('.st-label'), p.kind === 'edit' ? `Replacement ${i + 1} · − Before` : p.kind === 'bash' ? '$ Command' : 'File contents');
      setText(old, chunk.old ?? chunk.content ?? '');
      setText(section.querySelector('.st-new-label'), p.kind === 'edit' ? '+ After' : '');
      setText(next, chunk.new ?? '');
      next.hidden = p.kind !== 'edit';
      const signature = JSON.stringify(chunk);
      if (p.kind === 'edit' && block.phase !== 'args' && !block.argsTruncated && chunk.old !== undefined && chunk.new !== undefined && section._signature !== signature) {
        section._signature = signature;
        diff(chunk.old, chunk.new).then(script => {
          if (section._signature !== signature) return;
          const a = chunk.old.split('\n'), b = chunk.new.split('\n'); let x = 0, y = 0;
          const lines = Array.from(script, op => op === 0 ? (y++, '  ' + a[x++]) : op === 1 ? '− ' + a[x++] : '+ ' + b[y++]);
          setText(section.querySelector('.st-diff'), lines.join('\n'));
          section.querySelector('.st-diff').hidden = false;
          old.hidden = next.hidden = true;
          setText(section.querySelector('.st-label'), `Replacement ${i + 1}`);
          setText(section.querySelector('.st-new-label'), '');
        }).catch(() => {}); // Stable before/after remains usable if diffing fails.
      }
    });
  }
  // Strip terminal controls, including unfinished sequences at a live boundary.
  // Keep ordinary newlines/tabs; treat carriage-return progress as a rewritten line.
  function cleanOutput(text) {
    return String(text)
      .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g, '')
      .replace(/\x1b(?:[ -/]*[@-Z\\-_]|$)/g, '')
      .replace(/\r\n/g, '\n')
      .split('\n').map(line => line.slice(line.lastIndexOf('\r') + 1)).join('\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  }
  return { preview, render, cleanOutput };
});

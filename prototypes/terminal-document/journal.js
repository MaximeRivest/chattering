'use strict';
// Claude Code's own session log (~/.claude/projects/<folder>/<id>.jsonl),
// followed while the session runs. The screen is the live interaction; the
// log is the exact record of what the tools did (the full edit, not the
// few lines the screen shows). Read-only.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const projectDir = cwd => path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

class ClaudeJournal extends EventEmitter {
  constructor(cwd, since = Date.now()) {
    super();
    this.dir = projectDir(cwd); this.since = since - 2000;
    this.file = null; this.offset = 0; this.partial = ''; this.entries = [];
    this.timer = setInterval(() => this.poll(), 100);
  }
  poll() {
    try {
      if (!this.file) {
        const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl')).map(f => ({ f, m: fs.statSync(path.join(this.dir, f)).mtimeMs })).filter(x => x.m >= this.since).sort((a, b) => b.m - a.m);
        if (!files.length) return;
        this.file = path.join(this.dir, files[0].f);
      }
      const size = fs.statSync(this.file).size;
      if (size <= this.offset) return;
      const fd = fs.openSync(this.file, 'r'); const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset); fs.closeSync(fd); this.offset = size;
      const text = this.partial + buf.toString('utf8'); const lines = text.split('\n'); this.partial = lines.pop();
      const at = performance.now();
      for (const line of lines) { try { this.take(JSON.parse(line), at); } catch {} }
    } catch {}
  }
  take(r, at) {
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const b of content) {
      if (b.type === 'tool_use') {
        const i = b.input || {};
        const e = { kind: 'tool', id: b.id, name: b.name, at, path: i.file_path || i.path || null, command: i.command || null };
        if (b.name === 'Write') e.diff = { old: null, new: String(i.content || '') };
        if (b.name === 'Edit') e.diff = { old: String(i.old_string || ''), new: String(i.new_string || '') };
        if (b.name === 'MultiEdit' && Array.isArray(i.edits)) e.diff = { old: i.edits.map(x => x.old_string).join('\n…\n'), new: i.edits.map(x => x.new_string).join('\n…\n') };
        this.entries.push(e); this.emit('entry', e);
      } else if (b.type === 'tool_result') {
        const t = this.entries.find(x => x.id === b.tool_use_id);
        if (t) { t.result = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join('\n'); t.error = !!b.is_error; this.emit('entry', t); }
      } else if (b.type === 'text' && r.type === 'assistant') {
        const e = { kind: 'text', at, text: b.text }; this.entries.push(e); this.emit('entry', e);
      }
    }
  }
  close() { clearInterval(this.timer); }
}

module.exports = { ClaudeJournal, projectDir };

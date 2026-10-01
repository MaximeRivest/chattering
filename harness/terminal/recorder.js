'use strict';
// A session's recording: every byte the program printed, every key it
// received, every resize, on one clock (asciicast v2, the format of
// asciinema), gzip-compressed as it is written. Kept like a conversation's
// own file: the trace of what happened, replayable into the reader
// (scripts/terminal-replay.js) when something looked wrong.
//
// - Private: the file is created 0600 in a 0700 folder.
// - Readable at any moment: the stream is flushed every second, so a
//   session that ended badly (the one worth replaying) is on disk.
// - Bounded: past `maxBytes` of terminal data the recording stops, with a
//   last line saying so; the program goes on.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_BYTES = 64 * 1024 * 1024;

function createRecorder(file, { maxBytes = MAX_BYTES, clock = () => performance.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const out = fs.createWriteStream(file, { mode: 0o600, flags: 'w' });
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(out);
  let t0 = null, bytes = 0, full = false, closed = false, dirty = false;
  const timer = setInterval(() => { if (dirty && !closed) { dirty = false; gz.flush(zlib.constants.Z_SYNC_FLUSH); } }, 1000);
  timer.unref?.();
  const line = v => { if (closed) return; gz.write(JSON.stringify(v) + '\n'); dirty = true; };
  const at = () => +((clock() - t0) / 1000).toFixed(4);
  const event = (kind, data) => {
    if (closed || t0 == null || full) return;
    bytes += data.length;
    if (bytes > maxBytes) { full = true; line([at(), 'm', 'recording stopped: more than ' + Math.round(maxBytes / 1048576) + ' MB']); return; }
    line([at(), kind, data]);
  };
  return {
    file,
    start({ cols, rows, title = '', at: startedAt = Date.now() }) {
      if (t0 != null) return;
      t0 = clock();
      line({ version: 2, width: cols, height: rows, timestamp: Math.floor(startedAt / 1000), env: { TERM: 'xterm-256color' }, title });
    },
    output: data => event('o', data),
    input: data => event('i', data),
    resize: (cols, rows) => event('r', cols + 'x' + rows),
    marker: text => event('m', String(text)),
    get bytes() { return bytes; },
    close() {
      if (closed) return Promise.resolve();
      closed = true; clearInterval(timer);
      return new Promise(resolve => { out.once('close', resolve); out.once('error', resolve); gz.end(); });
    },
  };
}

// The devices' side of a session (hub.js): which device connected, what it
// sent, what it was answered and shown, on the recording's clock. JSON
// lines, gzip, private, flushed every second, bounded like the recording.
function createEventLog(file, { maxBytes = MAX_BYTES } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const out = fs.createWriteStream(file, { mode: 0o600, flags: 'w' });
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(out);
  let bytes = 0, closed = false, dirty = false, full = false;
  const timer = setInterval(() => { if (dirty && !closed) { dirty = false; gz.flush(zlib.constants.Z_SYNC_FLUSH); } }, 1000);
  timer.unref?.();
  return {
    file,
    write(obj) {
      if (closed || full) return;
      const line = JSON.stringify(obj) + '\n';
      bytes += line.length;
      if (bytes > maxBytes) { full = true; gz.write(JSON.stringify({ ev: 'log-full' }) + '\n'); dirty = true; return; }
      gz.write(line); dirty = true;
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true; clearInterval(timer);
      return new Promise(resolve => { out.once('close', resolve); out.once('error', resolve); gz.end(); });
    },
  };
}

// Any of these files, compressed or not, as its lines (a cut last line,
// from a session that ended badly, is left out).
function readLines(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const out = [];
  for (const l of buf.toString('utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { break; } }
  return out;
}

// The lines of a recording, compressed or not (older ones are plain).
function readRecording(file) {
  const out = readLines(file);
  return { head: out[0], events: out.slice(1) };
}

module.exports = { createRecorder, createEventLog, readRecording, readLines, MAX_BYTES };

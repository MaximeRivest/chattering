'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: require('./platform.js').gitNothingPaths().config, GIT_TERMINAL_PROMPT: '0' });
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + require('./platform.js').gitNothingPaths().hooks, ...args], { cwd, env, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function parseBlame(output) {
  const lines = output.split('\n'), head = /^([a-f0-9]{40,64})\s/.exec(lines[0]);
  if (!head) return { kind: 'unknown', reason: 'No Git attribution available' };
  if (/^0+$/.test(head[1])) return { kind: 'uncommitted', reason: 'Uncommitted line · author unknown' };
  const field = key => lines.find(line => line.startsWith(key + ' '))?.slice(key.length + 1) || '';
  return { kind: 'git', commit: head[1], author: field('author'), time: Number(field('author-time')) * 1000, summary: field('summary') };
}
async function blameLine(file, text, line) {
  if (!Number.isInteger(line) || line < 1 || line > text.split('\n').length) throw Error('Invalid line number');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || text.includes('\0')) return { kind: 'unknown', reason: 'Inline attribution is limited to text files up to 2 MiB' };
  try {
    // Both as the disk names them: git answers the long, real path (with /
    // on Windows); the file may arrive by a short name or through a link.
    const fsp = require('fs').promises;
    const root = await fsp.realpath((await git(path.dirname(file), ['rev-parse', '--show-toplevel'])).trim());
    const relative = path.relative(root, await fsp.realpath(file).catch(() => file)).split(path.sep).join('/');
    return parseBlame(await git(root, ['blame', '--no-textconv', '--line-porcelain', '-L', `${line},${line}`, '--contents', '-', '--', relative], text));
  } catch { return { kind: 'unknown', reason: 'No Git attribution available for this line' }; }
}
module.exports = { blameLine, parseBlame };

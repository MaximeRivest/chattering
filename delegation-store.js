'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'lost']);
// Only these can restart on the same session. cancelled is a user decision; succeeded needs no restart.
const RESUMABLE = new Set(['failed', 'lost']);
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function rootPath(options = {}) {
  return path.resolve(options.root || process.env.PI_DELEGATION_ROOT || path.join(require('./platform.js').appDirs().data, 'delegations'));
}
function taskDir(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid delegation ID');
  return path.join(root, id);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
function syncDir(dir) { require('./platform.js').syncDirSync(dir); }
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { require('./platform.js').renameSyncRetry(temp, file); syncDir(path.dirname(file)); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function appendEvent(dir, type, data = {}) {
  const fd = fs.openSync(path.join(dir, 'events.jsonl'), 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ version: 1, at: Date.now(), type, ...data }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
// A process's start time and the machine's boot distinguish a reused
// process ID, including across a reboot (processes.js: Linux, macOS,
// Windows each by their own means).
function identity(pid) { return require('./processes.js').identity(pid); }
function sameProcess(saved) {
  if (!saved) return false;
  const live = identity(saved.pid);
  return !!live && live.start === saved.start && live.boot === saved.boot;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function text(value, name, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw new Error(`${name} must be a non-empty string, at most ${max} characters`);
  return value;
}
function tools(value) {
  if (!Array.isArray(value) || value.length > 256 || value.some(t => typeof t !== 'string' || !/^[\w.-]+$/.test(t))) throw new Error('tools must be an array of tool names');
  if (new Set(value).size !== value.length) throw new Error('tools must not contain duplicates');
  return [...value];
}
function sameTools(a, b) { return Array.isArray(a) && Array.isArray(b) && canonicalJson([...a].sort()) === canonicalJson([...b].sort()); }
function normalizeMode(raw) {
  const allowed = ['key', 'label', 'opener', 'appendix', 'systemPrompt', 'removeSections', 'tools'];
  const sections = ['available_tools', 'custom_tools_note', 'guidelines', 'pi_docs', 'append_prompt', 'project_context', 'skills', 'date', 'cwd'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.includes(k))) throw new Error('Invalid ModeDef fields');
  if (typeof raw.key !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(raw.key)) throw new Error('Invalid mode key');
  const mode = { key: raw.key, label: text(raw.label, 'mode.label', 256).trim() };
  for (const key of ['opener', 'appendix', 'systemPrompt']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 256 * 1024 || raw[key].includes('\0'))) throw new Error(`Invalid mode.${key}`);
    if (raw[key]?.trim()) mode[key] = key === 'opener' ? raw[key].trim() : raw[key];
  }
  if (!mode.opener && !mode.appendix && !mode.systemPrompt) throw new Error('Mode requires opener, appendix, or systemPrompt');
  if (raw.removeSections !== undefined) {
    if (!Array.isArray(raw.removeSections) || raw.removeSections.some(s => !sections.includes(s))) throw new Error('Invalid mode.removeSections');
    if (raw.removeSections.length) mode.removeSections = [...raw.removeSections];
  }
  if (raw.tools !== undefined) mode.tools = tools(raw.tools);
  return mode;
}
// Why a worker stopped, in words a parent can act on. Text patterns are the
// only evidence a JSON printer leaves; the raw message is always kept beside it.
const OVERFLOW = [/prompt is too long/i, /request_too_large/i, /input is too long for requested model/i, /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i, /input token count.*exceeds the maximum/i, /maximum prompt length is \d+/i,
  /reduce the length of the messages/i, /maximum context length is \d+ tokens/i, /exceeds (?:the )?maximum allowed input length/i,
  /longer than the model'?s context length/i, /exceeds the limit of \d+/i, /exceeds the available context size/i, /greater than the context length/i,
  /context window exceeds limit/i, /exceeded model token limit/i, /too large for model with \d+ maximum context length/i,
  /configured context size is/i, /model_context_window_exceeded/i, /prompt too long; exceeded/i, /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i, /too many tokens/i, /token limit exceeded/i, /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i];
const NOT_OVERFLOW = [/^(?:Throttling error|Service unavailable):/i, /rate.?limit/i, /too many requests/i];
function classifyFailure(message, exit = {}) {
  const m = String(message || '');
  const kind = (() => {
    if (exit.exitSignal === 'SIGKILL' || exit.exitSignal === 'SIGTERM' || /^Worker exited with SIG/.test(m)) return 'interrupted';
    if (/\b(?:401|403)\b|unauthori[sz]ed|invalid (?:api )?key|authentication|expired token|not logged in|login required|permission_error/i.test(m)) return 'auth';
    if (/\b429\b|rate.?limit|throttl|too many requests|quota|usage limit|usage_limit|out of (?:usage|credits)|insufficient_quota|insufficient credits|billing|resets? (?:at|in)|limit reached|hit your limit|exceed(?:ed|s)? your (?:account'?s )?(?:current )?(?:rate|usage|quota|limit)/i.test(m)) return 'usage-limit';
    if (OVERFLOW.some(p => p.test(m)) && !NOT_OVERFLOW.some(p => p.test(m))) return 'context-overflow';
    if (/overloaded|\b(?:500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway time.?out|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|terminated|stream (?:closed|ended)|Request was aborted/i.test(m)) return 'overload';
    if (/mode contract|mode-switch|mode snapshot|does not match the (?:requested|saved)|model other than the exact|Delegated (?:mode|model)|Extension failed/i.test(m)) return 'contract';
    if (/Supervisor is missing|Supervisor could not start|Supervisor launch failed/i.test(m)) return 'interrupted';
    return 'unknown';
  })();
  return { kind, message: m.slice(0, 2000), resumable: kind !== 'contract' };
}
function resumeFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.map(n => /^resume-(\d+)\.json$/.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b)
    .map(n => ({ n, ...readJson(path.join(dir, `resume-${n}.json`)) }));
}
// A task is read from nine files; the listing reads every task every two
// seconds. Every task file is written by atomic() (a new file renamed into
// place), which changes the folder's modification time, so a folder whose
// time did not move holds the same task. Timestamps can be coarse (a clock
// tick): a folder that changed in the last two seconds is always read again,
// the rule git uses for its index. Callers get their own copy.
const TASK_CACHE_SETTLE_MS = 2000;
const taskCache = new Map(); // dir → { sig, task }
function readTask(root, id) {
  const dir = taskDir(root, id);
  let st = null;
  try { st = fs.statSync(dir, { bigint: true }); } catch {}
  const sig = st ? `${st.mtimeNs}:${st.ctimeNs}:${st.ino}` : null;
  const hit = sig && taskCache.get(dir);
  if (hit && hit.sig === sig) return structuredClone(hit.task);
  const task = readTaskFiles(dir);
  if (sig && Date.now() - Number(st.mtimeNs / 1000000n) > TASK_CACHE_SETTLE_MS) {
    if (taskCache.size >= 5000) taskCache.delete(taskCache.keys().next().value);
    taskCache.set(dir, { sig, task: structuredClone(task) });
  } else taskCache.delete(dir);
  return task;
}
function readTaskFiles(dir) {
  const spec = readJson(path.join(dir, 'request.json'));
  const state = readJson(path.join(dir, 'state.json'), {});
  const lost = readJson(path.join(dir, 'lost.json'), null);
  const review = readJson(path.join(dir, 'review.json'), {});
  const pause = readJson(path.join(dir, 'pause.json'), {});
  const cancel = readJson(path.join(dir, 'cancel.json'), {});
  const supervision = readJson(path.join(dir, 'supervision.json'), {});
  const takeover = readJson(path.join(dir, 'takeover.json'), null);
  const resumes = resumeFiles(dir);
  const last = resumes.at(-1);
  // The latest attempt owns the model and reasoning level. request.json keeps the original contract.
  const attempt = { attempt: resumes.length + 1, attemptRequestedAt: last ? last.at : spec.createdAt,
    ...(last ? { model: last.model, thinking: last.thinking, promptPath: last.promptPath, launchPath: last.launchPath } : {}),
    resumes: resumes.map(r => ({ attempt: r.n + 1, at: r.at, by: r.by, model: r.model, thinking: r.thinking, previousStatus: r.previousStatus, previousFailure: r.previousFailure || null })) };
  const models = [spec.model, ...resumes.map(r => r.model)].filter((m, i, all) => all.indexOf(m) === i);
  return { ...spec, ...attempt, ...state, supervision: supervision.kind || null, survivesServiceRestart: supervision.survivesServiceRestart === true, ...(lost && !TERMINAL.has(state.status) ? lost : {}), ...review,
    paused: !!pause.paused, cancelRequested: !!cancel.at, takenOver: takeover ? { at: takeover.at, model: takeover.model || null } : null,
    modelsUsed: models,
    updatedAt: Math.max(spec.updatedAt, state.updatedAt || 0, lost?.updatedAt || 0, review.updatedAt || 0, pause.at || 0, cancel.at || 0, last?.at || 0, takeover?.at || 0) };
}
function allIds(root) {
  try { return fs.readdirSync(root).filter(id => ID.test(id) && fs.existsSync(path.join(root, id, 'request.json'))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function ancestors(root, task) {
  const result = [task];
  const seen = new Set([task.id]);
  while (result.at(-1).parentTaskId) {
    const id = result.at(-1).parentTaskId;
    if (seen.has(id) || result.length >= 256) throw new Error('Invalid or excessive delegation ancestry');
    seen.add(id); result.push(readTask(root, id));
  }
  return result;
}
function gate(root, task) {
  const chain = ancestors(root, task);
  return { cancelled: chain.some(t => t.cancelRequested || t.status === 'cancelled'), paused: chain.some(t => t.paused) };
}
// Strict LF framing. Oversize lines are skipped without retaining their contents.
function jsonLines(onObject, onProblem = () => {}, max = 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '', dropping = false;
  function line(s) {
    if (!s.trim()) return;
    try { onObject(JSON.parse(s)); } catch (e) { onProblem('invalid JSON line'); }
  }
  function pushString(s) {
    let start = 0;
    for (;;) {
      const end = s.indexOf('\n', start);
      const part = s.slice(start, end < 0 ? undefined : end);
      if (!dropping) {
        if (pending.length + part.length > max) {
          const prefix = (pending.slice(0, 256) + part.slice(0, 256)).slice(0, 256);
          pending = ''; dropping = true; onProblem('oversize JSON line', { prefix });
        }
        else pending += part;
      }
      if (end < 0) break;
      if (!dropping) line(pending);
      pending = ''; dropping = false; start = end + 1;
    }
  }
  return { push(chunk) { pushString(typeof chunk === 'string' ? chunk : decoder.write(chunk)); }, end() { pushString(decoder.end()); if (pending && !dropping) line(pending); pending = ''; } };
}
async function scanJsonLines(file, onObject, onProblem) {
  const parser = jsonLines(onObject, onProblem);
  for await (const chunk of fs.createReadStream(file)) parser.push(chunk);
  parser.end();
}
// The last written entry ID. Pi appends in order, so this is where a resumed run continues.
async function sessionLeaf(file) {
  let leaf = null;
  await scanJsonLines(file, entry => { if (entry.type !== 'session' && typeof entry.id === 'string') leaf = entry.id; });
  return leaf;
}
module.exports = { TERMINAL, RESUMABLE, THINKING, classifyFailure, resumeFiles, ID, rootPath, taskDir, readJson, atomic, appendEvent, syncDir, identity, sameProcess,
  canonicalJson, sha256, text, tools, sameTools, normalizeMode, readTask, allIds, ancestors, gate, jsonLines, scanJsonLines, sessionLeaf };

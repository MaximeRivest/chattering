'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const S = require('./delegation-store');
const { childEnvironment } = require('./delegation');

function resultParser(expectedModel, onFatalFailure = () => {}, onRetryEvent = () => {}) {
  const result = { assistantCount: 0, stopReason: null, summary: '', error: null, fatalError: null, parseProblems: 0, skippedAggregateRecords: 0, modelMismatch: false };
  let sawMessageEnd = false;
  function message(msg) {
    if (msg?.role !== 'assistant') return;
    result.assistantCount++;
    result.stopReason = msg.stopReason;
    result.summary = (Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n') : '').slice(0, 8000);
    if (msg.provider && msg.model && `${msg.provider}/${msg.model}` !== expectedModel) result.modelMismatch = true;
    // A message error is an attempt outcome, not a settled run outcome.
    // Pi owns retry policy. Killing here interrupts retries and stdout flushing.
    result.error = msg.stopReason === 'error' || msg.stopReason === 'aborted' || msg.errorMessage
      ? String(msg.errorMessage || msg.stopReason).slice(0, 4000) : null;
  }
  const parser = S.jsonLines(event => {
    if (event.type === 'message_end') {
      sawMessageEnd = true;
      message(event.message);
    }
    // Older printers only emit agent_end. Do not replay historical attempts
    // when message_end already supplied the authoritative event sequence.
    if (event.type === 'agent_end' && !sawMessageEnd && Array.isArray(event.messages)) for (const msg of event.messages) message(msg);
    if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end') {
      onRetryEvent(event);
      if (event.type === 'auto_retry_end' && event.success === false) result.error = String(event.finalError || 'Model retry failed').slice(0, 4000);
    }
    if (event.type === 'extension_error') {
      result.fatalError = `Extension failed: ${String(event.error).slice(0, 4000)}`;
      onFatalFailure(result.fatalError);
    }
  }, (problem, detail) => {
    // Modern Pi duplicates the complete run in agent_end.messages. Once the
    // individual messages were observed, this aggregate is not authoritative.
    // Skip only the canonical leading type emitted by Pi, without buffering
    // an arbitrarily large history. Oversize individual/unknown records fail.
    if (problem === 'oversize JSON line' && sawMessageEnd &&
        /^\{"type":"agent_end",/.test(detail?.prefix || '')) {
      result.skippedAggregateRecords++;
    } else result.parseProblems++;
  });
  return { result, ...parser };
}
async function verifyTranscript(task) {
  if (S.sha256(S.normalizeMode(S.readJson(task.modePath))) !== task.modeHash) throw new Error('Persisted mode snapshot changed during execution');
  let found = 0, mismatch = false, problem = false, header = false, leafId = null;
  await S.scanJsonLines(task.sessionPath, entry => {
    if (entry.type === 'session') {
      header = entry.id === task.id && entry.cwd === task.cwd && !entry.parentSession;
    } else if (typeof entry.id === 'string') leafId = entry.id;
    if (entry.type === 'custom' && entry.customType === 'mode-switch') {
      found++;
      try {
        const mode = S.normalizeMode(entry.data?.definition);
        if (S.sha256(mode) !== task.modeHash || entry.data?.sha256 !== task.modeHash ||
          entry.data?.mode !== mode.key || !S.sameTools(entry.data?.effectiveTools, task.tools)) mismatch = true;
      } catch { mismatch = true; }
    }
  }, () => { problem = true; });
  if (!header) throw new Error('Saved session identity does not match the delegation');
  if (mismatch) throw new Error('Saved mode-switch does not match the requested mode hash or tools');
  if (!found) throw new Error('No saved mode-switch contract. Ensure the modes extension is loaded; work is not verified');
  if (problem) throw new Error('Saved transcript contains invalid or oversize JSON records; contract verification is incomplete');
  return { status: 'verified', snapshots: found, sha256: task.modeHash, leafId };
}

async function supervise(root, id) {
  const dir = S.taskDir(root, id);
  const task = S.readTask(root, id);
  if (S.TERMINAL.has(task.status)) return;
  // Exactly one launcher invokes this supervisor. Exclusive claim blocks accidental duplicate starts.
  const owner = S.identity(process.pid);
  if (!owner) throw new Error('Linux process identity is unavailable');
  const claim = path.join(dir, 'supervisor.json');
  const preparedClaim = path.join(dir, `owner-${process.pid}.json`);
  S.atomic(preparedClaim, owner);
  try { fs.linkSync(preparedClaim, claim); S.syncDir(dir); }
  finally { fs.unlinkSync(preparedClaim); }
  let child = null, childIdentity = null, exited = false, cancelling = false, cancelAt = 0, killed = false;
  let failureStopAt = 0, monitorError = null;
  let state = { status: 'starting', attempt: task.attempt, supervisorPid: process.pid, supervisorIdentity: owner, updatedAt: Date.now() };
  function save(patch) {
    state = { ...state, ...patch, updatedAt: Date.now() };
    S.atomic(path.join(dir, 'state.json'), state);
  }
  function signalChild(signal) {
    // Only this supervisor owns the live ChildProcess. Saved PIDs never authorize signalling.
    if (!child || exited || child.exitCode !== null || child.signalCode !== null || !S.sameProcess(childIdentity)) return false;
    const current = S.identity(child.pid);
    if (!current || current.pgrp !== child.pid || childIdentity.pgrp !== child.pid) return false;
    // Windows has no signals or process groups: the worker's tree ends.
    if (process.platform === 'win32') return require('./processes.js').stopTree(child.pid, signal);
    try { process.kill(-child.pid, signal); return true; }
    catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  }
  function requestCancel() {
    S.atomic(path.join(dir, 'cancel.json'), { at: Date.now() });
  }
  process.on('SIGTERM', requestCancel);
  process.on('SIGINT', requestCancel);
  let timer, stdoutFd, stderrFd;
  try {
    save({});
    S.appendEvent(dir, 'supervisor-started', { pid: process.pid });
    // Wait only if pause won the race after launch validation. Running work is not suspended.
    for (;;) {
      if (fs.existsSync(path.join(dir, 'lost.json'))) return;
      const effect = S.gate(root, S.readTask(root, id));
      if (effect.cancelled) { S.appendEvent(dir, 'cancelled'); save({ status: 'cancelled', finishedAt: Date.now() }); return; }
      if (!effect.paused) break;
      if (state.status !== 'planned') save({ status: 'planned' });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const mode = S.normalizeMode(S.readJson(task.modePath));
    if (S.sha256(mode) !== task.modeHash || !S.sameTools(mode.tools, task.tools)) throw new Error('Persisted mode snapshot changed before launch');
    // Each attempt has its own frozen command line. The first is launch.json.
    const invocation = S.readJson(task.launchPath || path.join(dir, 'launch.json'));
    stdoutFd = fs.openSync(task.logPath, 'a', 0o600);
    stderrFd = fs.openSync(task.stderrPath, 'a', 0o600);
    const parsed = resultParser(task.model, reason => {
      if (!failureStopAt) {
        failureStopAt = Date.now();
        S.appendEvent(dir, 'failure-signalled', { reason, signalled: signalChild('SIGTERM') });
      }
    }, event => {
      S.appendEvent(dir, event.type, { attempt: event.attempt, maxAttempts: event.maxAttempts,
        delayMs: event.delayMs, success: event.success });
    });
    // Recheck immediately before spawn. A later cancel is a durable marker read by every descendant.
    const lastGate = S.gate(root, S.readTask(root, id));
    if (lastGate.cancelled) { S.appendEvent(dir, 'cancelled'); save({ status: 'cancelled', finishedAt: Date.now() }); return; }
    if (lastGate.paused) throw new Error('Ancestor paused during spawn preflight; no worker launched');
    child = spawn(invocation.command, invocation.args, { cwd: task.cwd, env: childEnvironment(process.env, root, id),
      detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const outcome = new Promise(resolve => {
      let launchError = null, drainTimer, settled = false;
      const finish = (code, signal, pipeError = null) => {
        if (settled) return;
        settled = true; clearTimeout(drainTimer); parsed.end();
        resolve({ code, signal, launchError, pipeError });
      };
      child.once('error', error => { launchError = error.message; });
      child.once('spawn', () => {
        childIdentity = S.identity(child.pid);
        save({ status: 'running', pid: child.pid, processIdentity: childIdentity, startedAt: Date.now() });
        S.appendEvent(dir, 'worker-started', { pid: child.pid });
      });
      child.once('exit', (code, signal) => {
        exited = true;
        drainTimer = setTimeout(() => {
          // The group leader is gone. Do not signal its saved PID to close inherited pipes.
          child.stdout.destroy(); child.stderr.destroy();
          finish(code, signal, 'Worker exited but descendant output pipes remained open; descendant outcome is unknown');
        }, 2000);
      });
      child.once('close', (code, signal) => finish(code, signal));
    });
    child.stdout.on('data', chunk => { fs.writeFileSync(stdoutFd, chunk); parsed.push(chunk); });
    child.stderr.on('data', chunk => { fs.writeFileSync(stderrFd, chunk); });
    timer = setInterval(() => {
      try {
        const effect = monitorError ? { cancelled: false } : S.gate(root, S.readTask(root, id));
        if (effect.cancelled && !cancelling) {
          cancelling = true; cancelAt = Date.now();
          const signalled = signalChild('SIGTERM');
          save({ cancelRequested: true });
          S.appendEvent(dir, 'cancel-signalled', { signalled });
        }
        const stopAt = cancelAt || failureStopAt;
        if (stopAt && !killed && Date.now() - stopAt >= 1500) {
          killed = true;
          S.appendEvent(dir, cancelling ? 'cancel-kill' : 'failure-kill', { signalled: signalChild('SIGKILL') });
        }
      } catch (error) {
        monitorError = `Control monitoring failed: ${error.message}`;
        if (!failureStopAt) {
          failureStopAt = Date.now();
          S.appendEvent(dir, 'failure-signalled', { reason: monitorError, signalled: signalChild('SIGTERM') });
        }
      }
    }, 100);
    const exit = await outcome;
    clearInterval(timer);
    fs.fsyncSync(stdoutFd); fs.fsyncSync(stderrFd);
    const result = parsed.result;
    let verification, verificationError;
    try { verification = await verifyTranscript(task); } catch (e) { verificationError = e.message; }
    const cancelled = cancelling || (!monitorError && S.gate(root, S.readTask(root, id)).cancelled);
    let error = monitorError || exit.pipeError || (exit.launchError ? `Worker launch failed: ${exit.launchError}` : result.fatalError || result.error || (exit.code !== 0
      ? `Worker exited with ${exit.signal || exit.code}` : verificationError));
    if (!error && result.modelMismatch) error = 'Pi used a model other than the exact requested model';
    if (!error && (!result.assistantCount || result.stopReason !== 'stop' || !result.summary.trim())) error = 'Pi exited without a complete final assistant result';
    if (!error && result.parseProblems) error = 'Pi JSON output contains invalid or oversize records; result verification is incomplete';
    const status = cancelled ? 'cancelled' : error ? 'failed' : 'succeeded';
    const failure = status === 'failed' ? S.classifyFailure(error, { exitCode: exit.code, exitSignal: exit.signal }) : null;
    // The leaf marks where this attempt ended. A later resume refuses a moved session.
    let leafId = verification?.leafId ?? null;
    if (leafId === null) { try { leafId = await S.sessionLeaf(task.sessionPath); } catch {} }
    // Terminal state is the publication boundary. Readers can rely on its
    // result log and terminal audit event already being durable.
    S.appendEvent(dir, status, { exitCode: exit.code, exitSignal: exit.signal, ...(failure ? { failure: failure.kind } : {}) });
    save({ status, finishedAt: Date.now(), exitCode: exit.code, exitSignal: exit.signal, leafId,
      result: { summary: result.summary, stopReason: result.stopReason, parseProblems: result.parseProblems,
        skippedAggregateRecords: result.skippedAggregateRecords },
      modeVerification: verification ? { status: verification.status, snapshots: verification.snapshots, sha256: verification.sha256 } : { status: 'failed', error: verificationError },
      ...(error ? { error, failure } : {}) });
  } catch (error) {
    S.appendEvent(dir, 'failure-signalled', { reason: String(error.message).slice(0, 2000), signalled: signalChild('SIGTERM') });
    save({ status: 'failed', error: String(error.message).slice(0, 4000), failure: S.classifyFailure(error.message), finishedAt: Date.now() });
    S.appendEvent(dir, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    clearInterval(timer);
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    process.off('SIGTERM', requestCancel); process.off('SIGINT', requestCancel);
  }
}
if (require.main === module) {
  supervise(path.resolve(process.argv[2]), process.argv[3]).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
module.exports = { supervise, resultParser, verifyTranscript };

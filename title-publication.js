'use strict';
// Single-process publication coordination. No providers, settings or server imports.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

class TitlePublicationCancelled extends Error {
  constructor(reason) {
    super(`title publication cancelled: ${reason}`);
    this.code = 'TITLE_PUBLICATION_STALE';
    this.reason = reason;
  }
}

function synchronous(fn, ...args) {
  if (fn.constructor.name === 'AsyncFunction') throw new TypeError('publication boundary must be synchronous');
  const value = fn(...args);
  if (value && typeof value.then === 'function') throw new TypeError('publication boundary returned a promise');
  return value;
}

function sameBytes(a, b) {
  return a === null || b === null ? a === b : a.equals(b);
}

function createTitlePublication({ namesAllowed, io = fsp, disk = fs } = {}) {
  if (typeof namesAllowed !== 'function') throw new TypeError('namesAllowed is required');
  let policyEpoch = 0;
  const revisions = new Map();
  const queues = new Map();
  const tickets = new WeakMap();
  const explicitIntents = new Map();
  const revision = target => revisions.get(target) || 0;

  // Call on each effective names-policy change, INCLUDING revoke/re-enable.
  // This is a policy epoch, not a toggle of its own.
  function policyChanged() { policyEpoch++; }
  function invalidate(target) { revisions.set(target, revision(target) + 1); }
  function state(ticket) {
    const s = tickets.get(ticket);
    if (!s) throw new TypeError('ticket belongs to another title publisher');
    return s;
  }
  function snapshot(read) { return structuredClone(synchronous(read)); }
  function begin({ target, automatic = false, read }) {
    if (typeof target !== 'string' || !target || typeof read !== 'function') throw new TypeError('target and read are required');
    const expected = snapshot(read);
    const refused = !expected?.exists ? 'missing target'
      : automatic && !namesAllowed() ? 'names policy'
      : automatic && expected.manual ? 'manual owner'
      : automatic && explicitIntents.has(target) ? 'explicit title intent' : null;
    // A refused automatic request must not supersede an explicit request.
    if (!refused) invalidate(target);
    const ticket = Object.freeze({ target, automatic: !!automatic });
    tickets.set(ticket, { read, expected, refused, revision: revision(target), epoch: policyEpoch, writes: [], finished: false });
    if (!automatic && !refused) explicitIntents.set(target, ticket);
    return ticket;
  }
  function check(ticket) {
    const s = state(ticket);
    const now = snapshot(s.read);
    const reason = s.refused || (s.finished ? 'finished intent' : null)
      || (revision(ticket.target) !== s.revision ? 'newer title intent' : null)
      || (!now?.exists ? 'missing target' : null)
      || (ticket.automatic && (s.epoch !== policyEpoch || !namesAllowed()) ? 'names policy' : null)
      || (!isDeepStrictEqual(now, s.expected) ? 'source or ownership changed' : null);
    if (reason) throw new TitlePublicationCancelled(reason);
  }
  function committed(ticket) { return [...state(ticket).writes]; }
  function finish(ticket) {
    state(ticket).finished = true;
    if (explicitIntents.get(ticket.target) === ticket) explicitIntents.delete(ticket.target);
  }

  // One queue per canonical resource. Use the SAME coordinator for every writer
  // of a shared registry/cache, including manual edits and re-indexing.
  async function serialize(resource, work) {
    const key = path.resolve(resource);
    const previous = queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    queues.set(key, current);
    try { return await current; }
    finally { if (queues.get(key) === current) queues.delete(key); }
  }
  async function awaitCurrent(ticket, work) {
    check(ticket);
    const value = await work();
    check(ticket);
    return value;
  }

  // action must contain no await, promise, scheduled save, or async filesystem
  // mutation. Checks and the observable effect occupy one event-loop turn.
  // Own state changes are adopted only after this synchronous effect succeeds.
  function boundary(ticket, label, action, after = () => {}) {
    check(ticket);
    const value = synchronous(action);
    const s = state(ticket);
    s.writes.push(label);
    synchronous(after, value);
    s.expected = snapshot(s.read);
    return value;
  }
  async function readBytes(file) {
    try { return await io.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function readBytesSync(file) {
    try { return disk.readFileSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  // Stage privately with real awaited IO; compare the destination's exact bytes
  // again and authorize at synchronous rename, NOT before an awaited write.
  // transform receives the latest bytes under the shared queue (null if absent).
  // after runs synchronously after rename, normally updating memory + broadcasting.
  async function write(ticket, file, transform, after = () => {}) {
    file = path.resolve(file);
    return serialize(file, async () => {
      const before = await awaitCurrent(ticket, () => readBytes(file));
      const data = synchronous(transform, before);
      check(ticket);
      const tmp = `${file}.title-tmp-${process.pid}-${randomUUID()}`;
      let ownsTemp = false;
      let failure = null;
      try {
        // open wx establishes ownership; never unlink a file we did not create.
        const handle = await io.open(tmp, 'wx', 0o600);
        ownsTemp = true;
        try {
          check(ticket);
          await awaitCurrent(ticket, () => handle.writeFile(data));
        } finally { await handle.close(); }
        check(ticket); // close is awaited too
        if (!sameBytes(before, readBytesSync(file))) throw new TitlePublicationCancelled('destination changed');
        check(ticket);
        disk.renameSync(tmp, file); // no await between check, comparison and rename
        ownsTemp = false;
        // Record the durable success even if the memory/broadcast callback fails.
        const s = state(ticket);
        s.writes.push(file);
        const value = synchronous(after);
        s.expected = snapshot(s.read);
        return value;
      } catch (error) { failure = error; throw error; }
      finally {
        if (ownsTemp) {
          try { await io.unlink(tmp); }
          catch (error) {
            if (error.code !== 'ENOENT') {
              if (failure) failure.cleanupError = error;
              else throw error;
            }
          }
        }
      }
    });
  }

  return { begin, finish, invalidate, policyChanged, check, committed, serialize, awaitCurrent, boundary, write };
}

module.exports = { createTitlePublication, TitlePublicationCancelled };

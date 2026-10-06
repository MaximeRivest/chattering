'use strict';
// Fixture-only barriers in the real publisher's awaited staging, no production API.
const Module = require('node:module'), path = require('node:path');
const io = require('node:fs/promises'), fs = require('node:fs');
const readFileSync = fs.readFileSync;
let unreadableSource = false;
fs.readFileSync = function (file, ...args) {
  if (unreadableSource && String(file).replace(/\\/g, '/').endsWith('/sessions/fixture/source.jsonl')) {
    throw Object.assign(new Error('fixture source is unreadable'), { code: 'EIO' });
  }
  return readFileSync.call(this, file, ...args);
};
const load = Module._load;
const publisher = path.resolve(__dirname, '../title-publication.js');
let armed, entered = false, release, explicit = 0, finished = 0;
const active = new Set();
Module._load = function (name, parent, ...rest) {
  const value = load.call(this, name, parent, ...rest);
  if (Module._resolveFilename(name, parent) !== publisher) return value;
  return { ...value, createTitlePublication: options => {
    const p = value.createTitlePublication({ ...options, io: {
    ...io,
    async open(file, ...args) {
      const handle = await io.open(file, ...args);
      return {
        async writeFile(data) {
          await handle.writeFile(data);
          if (armed && path.basename(file).startsWith(armed + '.title-tmp-')) {
            armed = null; entered = true;
            await new Promise(resolve => { release = resolve; });
          }
        },
        close: () => handle.close(),
      };
    },
    } });
    const begin = p.begin;
    p.begin = options => {
      const ticket = begin(options);
      if (options.automatic) active.add(ticket); else explicit++;
      return ticket;
    };
    const finish = p.finish;
    p.finish = ticket => { if (active.delete(ticket)) finished++; return finish(ticket); };
    return p;
  } };
};
process.on('message', packet => {
  let value;
  if (packet.operation === 'arm') { armed = 'timeline-titles.json'; entered = false; }
  else if (packet.operation === 'entered') value = entered;
  else if (packet.operation === 'release') release?.();
  else if (packet.operation === 'explicit') value = explicit;
  else if (packet.operation === 'unreadable-source') unreadableSource = true;
  else if (packet.operation === 'tickets') value = { active: active.size, finished };
  else return;
  process.send({ id: packet.id, value });
});

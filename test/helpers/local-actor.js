'use strict';
// The hub's own actor (server.js localActor, design/106) for tests that run
// slices of server.js in a sandbox: the same operations table, in process.
const fs = require('node:fs');
const os = require('node:os');
const personOps = require('../../person-ops.js');

function localActorFor(home = os.homedir()) {
  const io = {
    stat: p => fs.promises.stat(p), realpath: p => fs.promises.realpath(p), readFile: p => fs.promises.readFile(p),
    readdir: p => fs.promises.readdir(p, { withFileTypes: true }),
  };
  return { kind: 'local', account: null, home, op: (name, ...args) => personOps.call(name, ...args), io };
}
// What a sandboxed slice needs to find the actor of a request or a path.
function actorGlobals(home) {
  const localActor = localActorFor(home);
  return {
    localActor, actorOf: () => localActor, actorForPath: () => localActor, ownFilesOf: () => null,
    pathExists: async p => { try { await fs.promises.stat(p); return true; } catch { return false; } },
  };
}
module.exports = { localActorFor, actorGlobals };

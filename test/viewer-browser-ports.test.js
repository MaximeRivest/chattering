'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute the real helper through server spawn/readiness, stopping before
// Chromium. No fixture server, browser, provider or user files are started.
function spawnBoundary(t, failAllocation = false, realNetwork = false) {
  const filename = path.join(__dirname, 'helpers/viewer-browser.js');
  const spawns = [], browserBoundary = new Error('browser boundary');
  const allocations = [], allocationError = new Error('injected second allocation failure');
  let homes = 0, readinessCalls = 0, closeOrder = 0;
  const network = {
    createServer() {
      const socket = new EventEmitter(), index = allocations.length;
      const state = { closed: false, addressed: false, heldAtClose: [] };
      allocations.push(state);
      socket.listen = (port, host, ready) => {
        assert.equal(port, 0); assert.equal(host, '127.0.0.1');
        queueMicrotask(() => {
          if (failAllocation && index === 1) socket.emit('error', allocationError);
          else ready();
        });
      };
      socket.address = () => { state.addressed = true; return { port: 31001 + index }; };
      socket.close = done => {
        state.heldAtClose = allocations.filter(a => a.addressed && !a.closed);
        state.closed = true; state.closeOrder = ++closeOrder; queueMicrotask(done);
      };
      return socket;
    },
  };
  const modules = {
    'node:assert/strict': assert,
    'node:fs': {
      realpathSync: { native: p => p },
      mkdtempSync: prefix => prefix + ++homes,
      mkdirSync() {}, writeFileSync() {},
    },
    'node:os': os, 'node:path': path, 'node:net': realNetwork ? net : network,
    'node:child_process': {
      spawn(command, args, options) {
        assert.equal(command, process.execPath);
        assert.deepEqual(Array.from(args), ['server.js']);
        assert.ok(allocations.every(a => a.closed), 'release reservations before server spawn');
        spawns.push(options);
        return Object.assign(new EventEmitter(), {
          exitCode: null, signalCode: null,
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
      },
    },
    './chromium.js': { chromiumBinary() { throw browserBoundary; } },
    './first-run.js': { answerFirstRun() {} },
    './home-env.js': require('./helpers/home-env.js'),
    './cleanup.js': { async stopAndRemove() {} },
  };
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename),
    require(name) {
      assert.ok(Object.hasOwn(modules, name), 'unexpected dependency: ' + name);
      return modules[name];
    },
    // Even an inherited fixed preview port must not leak into fixtures.
    process: { execPath: process.execPath, env: { CHATTERING_PREVIEW_PORT: '7435' } },
    setTimeout, clearTimeout,
    async fetch(url) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/api\/sessions$/);
      readinessCalls++;
      return { async json() { return [{ key: 'pi:fixture/media.jsonl' }]; } };
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return {
    spawns, allocations,
    async start(opts = {}) {
      await assert.rejects(sandbox.module.exports.viewerBrowser(t, opts), e => e === browserBoundary);
    },
    async fail() {
      await assert.rejects(sandbox.module.exports.viewerBrowser(t), e => e === allocationError);
    },
    readinessCalls: () => readinessCalls,
  };
}

// Probe unchanged production port conversion/listen source using real listeners.
// Only call this with numbers obtained from real OS allocations, not doubles.
async function probeListeners(t, spawns) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const declaration = source.match(/^const PREVIEW_PORT = .*;$/m)?.[0];
  const listen = source.match(/^  previewServer\.listen\(PREVIEW_PORT, HOST, .*;$/m)?.[0];
  assert.ok(declaration && listen, 'server preview listener source must be found');
  const listeners = spawns.map(() => http.createServer());
  t.after(async () => {
    await Promise.all(listeners.map(s => new Promise((resolve, reject) => {
      if (!s.listening) return resolve();
      s.close(e => e ? reject(e) : resolve());
    })));
  });
  const ports = await Promise.all(listeners.map((previewServer, i) => new Promise((resolve, reject) => {
    previewServer.once('error', reject);
    previewServer.once('listening', () => resolve(previewServer.address().port));
    const advertised = vm.runInNewContext(declaration + '\n' + listen + '\nPREVIEW_PORT', {
      process: { env: spawns[i].env }, previewServer,
      HOST: '127.0.0.1', console: { log() {} },
    });
    assert.equal(advertised, Number(spawns[i].env.CHATTERING_PREVIEW_PORT));
  })));
  assert.equal(new Set(ports).size, spawns.length, 'simultaneous listeners must own distinct ports');
  ports.forEach((port, i) => assert.equal(port, Number(spawns[i].env.CHATTERING_PREVIEW_PORT),
    'bound port must equal the advertised environment number'));
}

test('Given real OS port allocation, When concurrent helpers spawn, Then the unchanged listener binds each advertised positive port', async t => {
  const boundary = spawnBoundary(t, false, true);
  await Promise.all([boundary.start(), boundary.start()]);
  for (const { env } of boundary.spawns) {
    assert.ok(Number(env.CHATTERING_PREVIEW_PORT) > 0);
    assert.notEqual(env.CHATTERING_PREVIEW_PORT, env.PORT);
  }
  await probeListeners(t, boundary.spawns);
});

test('Scenario: concurrent browser fixtures advertise distinct usable preview ports', async t => {
  let boundary;
  await t.test('Given two fixtures inheriting the shared preview port 7435', () => {
    boundary = spawnBoundary(t);
  });
  await t.test('When both actual helpers reach server spawn concurrently', async () => {
    await Promise.all([boundary.start(), boundary.start()]);
    assert.equal(boundary.spawns.length, 2);
    assert.equal(boundary.readinessCalls(), 2);
    assert.notEqual(boundary.spawns[0].env.HOME, boundary.spawns[1].env.HOME);
  });
  await t.test('Then advertised preview ports are positive and distinct from both app ports and each other', async () => {
    const allPorts = [];
    for (const { env } of boundary.spawns) {
      const preview = Number(env.CHATTERING_PREVIEW_PORT);
      assert.ok(Number.isInteger(preview) && preview > 0 && preview <= 65535,
        'fixture must advertise a positive usable preview port, not 0');
      assert.notEqual(preview, 7435);
      allPorts.push(Number(env.PORT), preview);
    }
    assert.equal(new Set(allPorts).size, 4);
    assert.equal(boundary.allocations.length, 4);
    assert.ok(boundary.allocations.every(a => a.closed));
    for (const { env } of boundary.spawns) {
      const app = boundary.allocations[Number(env.PORT) - 31001];
      const preview = boundary.allocations[Number(env.CHATTERING_PREVIEW_PORT) - 31001];
      const first = app.closeOrder < preview.closeOrder ? app : preview;
      assert.ok(first.heldAtClose.includes(app) && first.heldAtClose.includes(preview),
        'hold both fixture reservations until their numbers are known');
    }

  });
});

test('Scenario: an explicit preview-port override remains authoritative', async t => {
  let boundary, opts;
  await t.test('Given opts.env specifies preview port 31099', () => {
    boundary = spawnBoundary(t);
    opts = { env: { CHATTERING_PREVIEW_PORT: '31099' } };
  });
  await t.test('When the actual helper spawns with that override', async () => {
    await boundary.start(opts);
  });
  await t.test('Then the spawn keeps the explicitly advertised port', () => {
    assert.equal(boundary.spawns[0].env.CHATTERING_PREVIEW_PORT, '31099');
  });
});

test('Scenario: allocation failure releases all owned sockets without spawning', async t => {
  // Fixed numbers above are boundary doubles only; never bind them in CI.
  let boundary;
  await t.test('Given the second allocation emits an error', () => {
    boundary = spawnBoundary(t, true);
  });
  await t.test('When the actual helper attempts to reserve its ports', () => boundary.fail());
  await t.test('Then both owned sockets are closed and no child is spawned', () => {
    assert.equal(boundary.allocations.length, 2);
    assert.ok(boundary.allocations.every(a => a.closed));
    assert.equal(boundary.spawns.length, 0);
  });
});

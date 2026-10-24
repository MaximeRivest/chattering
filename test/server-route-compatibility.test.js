'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

// Exercise the route without starting the server or reading the user's files.
function pathReadHandler(context) {
  const marker = "    } else if (u.pathname === '/api/path/read' && req.method === 'GET') {";
  const start = source.indexOf(marker);
  const end = source.indexOf('\n    } else if (', start + marker.length);
  assert.ok(start >= 0 && end > start);
  // A household member: this server reads the file (design/105 hands it to
  // a person's own account otherwise).
  return vm.runInNewContext('(async () => {' + source.slice(start + marker.length, end) + '\n})', { ownFilesOf: () => null, identity: {}, ...context });
}

test('path/read keeps transcript scope, path, and local-request checks after alias removal', async () => {
  for (const local of [true, false]) {
    const req = {}, res = {}, calls = [];
    const data = { content: 'fixture' };
    const handler = pathReadHandler({ req, res,
      u: new URL('http://localhost/api/path/read?id=pi%3Afixture&path=src%2Fa%20b.js'),
      // The console is this machine with the install token (design/53).
      isConsoleRequest: value => { assert.equal(value, req); return local; },
      transcriptFileReadResponse: async (...args) => { calls.push(args); return data; },
      json: (response, status, body) => { assert.equal(response, res); assert.equal(status, 200); assert.equal(body, data); },
    });
    await handler();
    assert.deepEqual(calls, [['pi:fixture', 'src/a b.js', local]]);
  }
});

test('path/read keeps the existing error response', async () => {
  let status, error;
  const handler = pathReadHandler({ req: {}, res: {}, u: new URL('http://localhost/api/path/read'),
    isConsoleRequest: () => false,
    transcriptFileReadResponse: async () => { throw new Error('not in transcript'); },
    json: (_res, code, body) => { status = code; error = body.error; },
  });
  await handler();
  assert.equal(status, 404);
  assert.equal(error, 'not in transcript');
});

test('cleanup keeps standalone APIs and terminal slash-key support', () => {
  for (const route of ['/api/here', '/api/modes/delete', '/api/conversation/diffs',
    '/api/project/memory', '/api/memory/leaf', '/api/models/last',
    '/api/conversation/act', '/api/conversation/thinking', '/api/conversation/models']) {
    assert.ok(source.includes("u.pathname === '" + route + "'"), route);
  }
  for (const name of ['captureConversation', 'openConversationInTerminal']) {
    assert.ok(source.includes('async function ' + name + '('), name);
  }
  assert.ok(!source.includes("u.pathname === '/api/conversation/file'"));
});

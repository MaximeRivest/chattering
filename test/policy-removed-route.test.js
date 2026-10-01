'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../policy.js');

// Given: this endpoint has no server handler. Retiring its guest entry must
// leave the existing deny-by-default contract, not exempt it from inventory.
test('Given an unserved compose endpoint, When a guest or member requests it, Then the policy denies access', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /u\.pathname\s*===\s*['"]\/api\/node\/compose['"]/);
  for (const scope of ['guest', 'household']) {
    const caller = { tier: 'member', user: { id: scope, role: 'member', scope } };
    const result = policy.checkRoute(caller, 'POST', '/api/node/compose', new URLSearchParams(), () => true);
    assert.equal(result.ok, false, scope + ' must not inherit an obsolete guest grant');
    assert.equal(result.status, 403);
  }
});

test('Given the owner and an unclassified endpoint, When policy is checked, Then the established owner fallback remains unchanged', () => {
  const owner = { tier: 'owner', user: { id: 'owner', role: 'owner', scope: 'household' } };
  assert.equal(policy.checkRoute(owner, 'POST', '/api/node/compose', new URLSearchParams(), () => true).ok, true);
});

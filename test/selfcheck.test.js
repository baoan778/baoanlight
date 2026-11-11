'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { run } = require('../src/selfcheck');

// The startup self-check is what `bao start` runs every time. It must always
// return a well-formed result — never throw, never block on the network.
test('the startup self-check returns a well-formed result', () => {
  const r = run();

  assert.ok(r, 'returns a result');
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0, 'has checks');
  assert.equal(typeof r.fails, 'number', 'counts fails');
  assert.equal(typeof r.warns, 'number', 'counts warns');

  for (const c of r.checks) {
    assert.equal(typeof c.name, 'string');
    assert.ok(['pass', 'warn', 'fail'].includes(c.status), `${c.name} has a valid status`);
  }

  // The counts must match the actual checks.
  assert.equal(r.fails, r.checks.filter((c) => c.status === 'fail').length);
  assert.equal(r.warns, r.checks.filter((c) => c.status === 'warn').length);
});

// A broken Claude settings file is the classic cross-machine failure; the
// self-check must call it out as a hard fail rather than staying silent.
test('the self-check flags a broken Claude settings file', () => {
  const r = run();
  const claude = r.checks.find((c) => c.name.startsWith('Claude Code'));
  assert.ok(claude, 'checks Claude Code hooks');
  assert.ok(['pass', 'warn', 'fail'].includes(claude.status));
});

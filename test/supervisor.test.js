'use strict';
// 整机守护的规则：崩溃重开，正常退出绝不复活。
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { supervise } = require('../src/supervisor');

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function fakeChildren() {
  const kids = [];
  const spawnChild = () => {
    const c = new EventEmitter();
    c.kill = () => { c.killed = true; };
    kids.push(c);
    return c;
  };
  return { kids, spawnChild };
}

test('a crashed stack is restarted', async () => {
  const { kids, spawnChild } = fakeChildren();
  const sup = supervise(spawnChild, { backoff: [20], stableMs: 0, exit: () => {} });
  assert.equal(kids.length, 1);

  kids[0].emit('exit', 1);
  await settle(50);
  assert.equal(kids.length, 2, 'it comes back after the first backoff');
  sup.stop();
});

test('a clean exit is the user asking to stop — never revived', async () => {
  const { kids, spawnChild } = fakeChildren();
  let exited = null;
  supervise(spawnChild, { backoff: [10], exit: (code) => { exited = code; } });

  kids[0].emit('exit', 0);
  await settle(40);
  assert.equal(exited, 0, 'the supervisor exits with the same code');
  assert.equal(kids.length, 1, 'and never respawns');
});

test('repeated crashes back off, and the delay is capped', async () => {
  const { kids, spawnChild } = fakeChildren();
  const waits = [];
  const sup = supervise(spawnChild, {
    backoff: [10, 20],
    stableMs: 60_000,
    exit: () => {},
    log: ({ wait }) => waits.push(wait),
  });

  kids[0].emit('exit', 1);
  await settle(25);
  kids[1].emit('exit', 1);
  await settle(40);
  kids[2].emit('exit', 1);
  await settle(10);

  assert.deepEqual(waits, [10, 20, 20], 'grows, then stays at the last value');
  sup.stop();
});

test('a stable run resets the backoff', async () => {
  const { kids, spawnChild } = fakeChildren();
  const waits = [];
  const sup = supervise(spawnChild, {
    backoff: [10, 20],
    stableMs: 0,          // 每次退出都被视为「已经稳定运行过」
    exit: () => {},
    log: ({ wait }) => waits.push(wait),
  });

  kids[0].emit('exit', 1);
  await settle(25);
  kids[1].emit('exit', 1);
  await settle(10);

  assert.deepEqual(waits, [10, 10], 'a healthy run does not inherit the old backoff');
  sup.stop();
});

test('stop() kills the live child and prevents a restart', async () => {
  const { kids, spawnChild } = fakeChildren();
  const sup = supervise(spawnChild, { backoff: [10], exit: () => {} });

  sup.stop();
  assert.equal(kids[0].killed, true);
  await settle(30);
  assert.equal(kids.length, 1, 'nothing is respawned after stop');
});

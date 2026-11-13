'use strict';
// 本机资源采样：面板上写的每个数字都必须来自真实的 os 读数。
const { test } = require('node:test');
const assert = require('node:assert');
const { sample } = require('../src/sysinfo');

test('sysinfo reports bounded CPU and memory readings', () => {
  const s = sample();
  assert.ok(s && typeof s === 'object', 'a reading is always an object');
  assert.ok(Number.isFinite(s.cpu) && s.cpu >= 0 && s.cpu <= 100, `cpu out of range: ${s.cpu}`);
  assert.ok(s.mem && s.mem.total > 0, 'total memory is known');
  assert.ok(s.mem.used >= 0 && s.mem.used <= s.mem.total, 'used memory cannot exceed total');
  assert.ok(s.mem.percent >= 0 && s.mem.percent <= 100, `memory percent out of range: ${s.mem.percent}`);
  assert.ok(s.cores >= 1, 'at least one core');
});

test('a second reading is cached instead of burning a core', () => {
  const a = sample();
  const b = sample();
  assert.equal(a, b, 'inside the 1s window the same object is reused');
});

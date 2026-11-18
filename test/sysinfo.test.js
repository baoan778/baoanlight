'use strict';
// 本机资源采样：面板上写的每个数字都必须来自真实的 os 读数。
const { test } = require('node:test');
const assert = require('node:assert');
const { sample, parseNvidiaSmi } = require('../src/sysinfo');

test('sysinfo reports bounded CPU and memory readings', () => {
  const s = sample();
  assert.ok(s && typeof s === 'object', 'a reading is always an object');
  assert.ok(Number.isFinite(s.cpu) && s.cpu >= 0 && s.cpu <= 100, `cpu out of range: ${s.cpu}`);
  assert.ok(s.mem && s.mem.total > 0, 'total memory is known');
  assert.ok(s.mem.used >= 0 && s.mem.used <= s.mem.total, 'used memory cannot exceed total');
  assert.ok(s.mem.percent >= 0 && s.mem.percent <= 100, `memory percent out of range: ${s.mem.percent}`);
  assert.ok(s.cores >= 1, 'at least one core');
  assert.ok('gpu' in s, 'gpu is either a reading or null — never a fake number');
});

// GPU 只在有 NVIDIA 读数时出现；解析必须对多显卡/异常输出都给出可用的结果。
test('nvidia-smi output becomes utilisation and memory', () => {
  const g = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 37, 2048, 24564\n');
  assert.equal(g.name, 'NVIDIA GeForce RTX 4090');
  assert.equal(g.percent, 37);
  assert.equal(g.mem.used, 2048 * 1048576);
  assert.equal(g.mem.total, 24564 * 1048576);

  assert.equal(parseNvidiaSmi(''), null, 'no output means no reading');
  assert.equal(parseNvidiaSmi('garbage'), null);
  assert.equal(parseNvidiaSmi('NVIDIA, n/a, 1, 2'), null, 'unparsable numbers are not a reading');
  assert.equal(parseNvidiaSmi('GPU, 150, -1, 0').percent, 100, 'out-of-range usage clamps');
  assert.equal(parseNvidiaSmi('GPU, 150, -1, 0').mem.used, 0, 'negative memory clamps to zero');
});

test('a second reading is cached instead of burning a core', () => {
  const a = sample();
  const b = sample();
  assert.equal(a, b, 'inside the 1s window the same object is reused');
});

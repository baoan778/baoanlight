'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离缓存文件，别污染用户真实家目录。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-upd-'));

const { check, lastValue, reset } = require('../src/update-check');

test('a newer version on the registry is reported, without phoning home twice', async () => {
  reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ version: '9.9.9' }) };
  };

  const r = await check({ fetchImpl });
  assert.equal(r.newer, true);
  assert.equal(r.latest, '9.9.9');
  assert.equal(typeof r.current, 'string');
  assert.equal(calls, 1);

  // 第二次命中缓存：不再联网。
  const r2 = await check({ fetchImpl });
  assert.equal(r2.newer, true);
  assert.equal(calls, 1, 'the 24h cache stops a second network call');
  assert.equal(lastValue().latest, '9.9.9');
});

test('offline or a bad response degrades to "no newer version", never an error', async () => {
  reset();
  const bad = await check({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(bad.newer, false);
  assert.equal(bad.latest, bad.current, 'falls back to the local version');

  const notJson = await check({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) });
  assert.equal(notJson.newer, false);
});

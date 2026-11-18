'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离缓存文件，别污染用户真实家目录。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-upd-'));

const { check, lastValue, reset, isNewer } = require('../src/update-check');

test('prerelease versions compare by semver rules, not lexically', () => {
  assert.equal(isNewer('2.1.0-alpha.10', '2.1.0-alpha.2'), true);
  assert.equal(isNewer('2.1.0-alpha.2', '2.1.0-alpha.10'), false);
  assert.equal(isNewer('2.1.0-beta.1', '2.1.0-alpha.9'), true, 'beta outranks alpha');
  assert.equal(isNewer('2.1.0-alpha', '2.1.0-1'), true, 'alphanumeric outranks numeric');
  assert.equal(isNewer('2.1.0', '2.1.0-beta.2'), true, 'a release outranks a prerelease');
  assert.equal(isNewer('2.1.0-beta.2', '2.1.0'), false);
  assert.equal(isNewer('2.0.1-alpha', '2.0.0'), true, 'a newer core still wins');
});

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

test('a registry behind the installed version is not an update', async () => {
  reset();
  const r = await check({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.0.1' }) }) });
  assert.equal(r.newer, false, 'the installed build is ahead; never suggest a downgrade');

  // 缓存里存着更老的版本时，同样不能用「字符串不同」来判断有新版本。
  const cached = await check({ fetchImpl: async () => { throw new Error('should not fetch twice'); } });
  assert.equal(cached.latest, '0.0.1');
  assert.equal(cached.newer, false, 'a cached older version is still not newer');
});

test('offline or a bad response degrades to "no newer version", never an error', async () => {
  reset();
  const bad = await check({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(bad.newer, false);
  assert.equal(bad.latest, bad.current, 'falls back to the local version');

  const notJson = await check({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) });
  assert.equal(notJson.newer, false);
});

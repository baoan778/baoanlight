'use strict';
const http = require('http');
const config = require('./config');
const auth = require('./auth');

// Everything here is best-effort. A hook that throws would break the agent it is
// reporting on, so failures are swallowed and the caller still exits 0.
// A 401/403 used to disappear into `resolve(null)`: every hook kept exiting 0,
// the CLI kept being "successful", and the lamp simply stopped moving with no
// explanation anywhere. Say it once per process — still never throw, because a
// broken indicator must not break the agent it reports on.
let authWarned = false;

function post(pathname, payload, { timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: config.runningPort(),
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          // 写入必须证明「我是本机那个用户」：见 src/auth.js 的说明。
          'x-bao-token': auth.token(),
        },
      },
      (res) => {
        if ((res.statusCode === 401 || res.statusCode === 403) && !authWarned) {
          authWarned = true;
          process.stderr.write(
            'baoanlight: write refused (' + res.statusCode + '). The token in '
            + config.DIR + ' does not match the running server — run `bao doctor`,'
            + ' or restart with `bao stop && bao start`.\n'
          );
        }
        // 和 server 的 readBody 同一条规矩：按字节收，最后一次性解码。
        // `out += chunk` 会对每个 TCP 分片各做一次 UTF-8 解码，一个中文字符
        // 正好跨在两个分片之间时，两边都会变成 U+FFFD（详情里的「�」）。
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
        });
        // 响应流中途出错（server 被 kill、连接被重置）时错误是异步 emit 的：
        // 没有监听器就是未捕获异常，钩子进程以非 0 退出 —— 正好违反「钩子
        // 永远不打断它监视的代理」。吞掉它，和请求本身的错误一样处理。
        res.on('error', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function get(pathname, { timeout = 1200, port } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(port) || config.runningPort(), path: pathname, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const setState = (payload) => post('/state', payload);
const noteUnknown = (payload) => post('/unknown', payload);
// 端口上应答的不一定是 baoanlight：别的本地服务也可能占着同一个端口。不认名字
// 的话，`bao start` 会以为「已经在运行」，然后把一个陌生页面装进带 quit / 开终端
// 权限的 Electron 壳里；`bao stop` 也会对着别人的服务发 /quit。
const health = async () => {
  const r = await get('/health');
  return r && r.name === 'baoanlight' ? r : null;
};
// 指定端口问一次：`bao start --port X` 要确认「端口文件里记着的那个旧实例」
// 是不是还活着，而运行时端口函数只会返回这次的 X。
const healthAt = async (port) => {
  const r = await get('/health', { port });
  return r && r.name === 'baoanlight' ? r : null;
};
const snapshot = () => get('/state');
const quitServer = () => post('/quit', {});

module.exports = { post, get, setState, noteUnknown, health, healthAt, snapshot, quitServer };

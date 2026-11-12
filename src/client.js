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
        port: config.port(),
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
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try { resolve(JSON.parse(out)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function get(pathname, { timeout = 1200 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: config.port(), path: pathname, timeout },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try { resolve(JSON.parse(out)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const setState = (payload) => post('/state', payload);
const noteUnknown = (payload) => post('/unknown', payload);
const clearUnknown = () => post('/unknown/clear', {});
const health = () => get('/health');
const snapshot = () => get('/state');
const quitServer = () => post('/quit', {});

module.exports = { post, get, setState, noteUnknown, clearUnknown, health, snapshot, quitServer };

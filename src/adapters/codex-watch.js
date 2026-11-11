'use strict';
// Codex used to have its own watcher before `bao watch` grew other agents.
// The implementation now lives in log-watch.js; this file keeps the old
// entry point working for scripts that imported it directly.

const watch = require('./log-watch');

// `classify` and `readFuel` are re-exported as-is: they are Codex's own shapes
// and the tests pin them down.
module.exports = {
  run: (opts = {}) => watch.run({ ...opts, agent: 'codex' }),
  classify: watch.classify,
  readFuel: watch.readFuel,
  newestFiles: watch.newestFiles,
};

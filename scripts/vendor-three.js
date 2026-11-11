'use strict';
// Copies three.js's built ES modules into the overlay.
//
// The overlay is served as plain static files from src/overlay, and it has to
// render on a machine that never ran `npm install` (the packaged app ships
// `src`, not `node_modules`). So the build output is vendored, not imported
// from a dependency at runtime. `three` stays a devDependency: it is a build
// input, not a runtime requirement.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', 'three', 'build');
const OUT = path.join(__dirname, '..', 'src', 'overlay', 'vendor');
const FILES = ['three.module.js', 'three.core.js'];

if (!fs.existsSync(SRC)) {
  console.error('three is not installed — run: npm install');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of FILES) {
  const from = path.join(SRC, file);
  if (!fs.existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(OUT, file));
  const kb = Math.round(fs.statSync(from).size / 1024);
  console.log(`vendored ${file} (${kb} KB)`);
}

const version = require('three/package.json').version;
console.log(`three ${version} — MIT, license headers retained in the copied files`);

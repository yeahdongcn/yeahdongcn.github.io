'use strict';
// NEON TURF — headless test harness.
// Loads every <script data-sim> from ../index.html, in page order, into this
// Node process (no DOM, no canvas). index.html is the single source of truth
// for load order, so the browser and the tests can never drift apart.
//
//   const { NT, check, section, run, load, done } = require('./harness');
// (Use this from a test FILE. With `node -e` a top-level `const NT` would shadow
// the global the sim files look up and you get "NT is not defined".)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = [];
html.replace(/<script\b([^>]*)>/g, function (_, attrs) {
  if (!/\bdata-sim\b/.test(attrs)) return '';
  const m = /\bsrc="([^"?]+)/.exec(attrs);
  if (m) files.push(m[1]);
  return '';
});
if (!files.length) throw new Error('harness: no <script data-sim> tags found in index.html');

// Touching the DOM from a sim file must fail loudly, not silently pass in the browser only.
for (const g of ['window', 'document', 'navigator', 'localStorage', 'requestAnimationFrame']) {
  if (!(g in globalThis)) {
    Object.defineProperty(globalThis, g, { configurable: true, get() { throw new Error('sim file touched `' + g + '` (sim code must be headless-safe)'); } });
  }
}
// Files listed in index.html but not written yet are skipped and reported in
// `missing`; smoke.js asserts the list is empty, so a release can never ship a hole.
const missing = [];
for (const f of files) {
  const file = path.join(root, f);
  if (!fs.existsSync(file)) { missing.push(f); continue; }
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

// Load an extra plain-script file (path relative to rts/), e.g. a test-only faction fixture.
function load(rel) {
  const file = path.join(root, rel);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

let failures = 0, checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  FAIL: ' + msg); }
  return !!cond;
}
function section(name) { console.log('\n== ' + name); }
function done() {
  console.log('\n' + (failures ? 'FAILED' : 'OK') + ': ' + (checks - failures) + '/' + checks + ' checks passed');
  process.exit(failures ? 1 : 0);
}
// Step the world n ticks (or until pred(world) is true). Returns ticks run.
function run(world, n, pred) {
  let i = 0;
  for (; i < n; i++) { if (pred && pred(world)) break; globalThis.NT.step(world); }
  return i;
}

module.exports = { NT: globalThis.NT, files, missing, load, check, section, done, run };

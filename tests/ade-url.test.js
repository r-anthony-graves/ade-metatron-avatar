const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('avatar defaults to the twin on :8301', () => {
  const main = read('main.js');
  assert.match(main, /ADE_BASE = process\.env\.ADEOS_URL \|\| 'http:\/\/127\.0\.0\.1:8301'/);
});

test('run-avatar.ps1 defaults to :8301 and never falls back to :8300', () => {
  const ps = read('run-avatar.ps1');
  assert.match(ps, /\[string\]\$AdeUrl = 'http:\/\/127\.0\.0\.1:8301'/);
  assert.doesNotMatch(read('main.js'), /8300/);
  assert.doesNotMatch(read('preload.js'), /8300/);
});

test('run-avatar.ps1 boots the twin by default and can opt out', () => {
  const ps = read('run-avatar.ps1');
  assert.match(ps, /NoTwin/);
  assert.match(ps, /adeos-run-avatar\.ps1/);
});

test('main.js offers a Boot twin tray action', () => {
  const main = read('main.js');
  assert.match(main, /Boot twin/);
  assert.match(main, /child_process/);
});

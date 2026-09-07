'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { filesRoot, ensureFilesLayout, FILES_SUBDIRS } = require('../files-store');

test('files live in a files/ tree under the avatar userData', () => {
  const root = filesRoot('C:\\Users\\ray_g\\AppData\\Roaming\\adeos-avatar');
  assert.equal(root, path.join('C:\\Users\\ray_g\\AppData\\Roaming\\adeos-avatar', 'files'));
});

test('the layout is exactly voice, uploads, exports, scratch', () => {
  assert.deepEqual(FILES_SUBDIRS.slice().sort(),
    ['exports', 'scratch', 'uploads', 'voice']);
});

test('ensureFilesLayout creates the four subfolders and nothing else', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-files-layout-'));
  const root = ensureFilesLayout(userData);
  assert.equal(root, path.join(userData, 'files'));
  const names = fs.readdirSync(root).sort();
  assert.deepEqual(names, ['exports', 'scratch', 'uploads', 'voice']);
  for (const name of names) {
    assert.ok(fs.statSync(path.join(root, name)).isDirectory(), name + ' is not a directory');
  }
  fs.rmSync(userData, { recursive: true, force: true });
});

test('ensureFilesLayout is safe to call twice', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-files-again-'));
  const first = ensureFilesLayout(userData);
  const second = ensureFilesLayout(userData);
  assert.equal(first, second);
  assert.deepEqual(fs.readdirSync(first).sort(), ['exports', 'scratch', 'uploads', 'voice']);
  fs.rmSync(userData, { recursive: true, force: true });
});

test('main.js opens the files tree from the tray and keeps smoke off AppData', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.indexOf("require('./files-store')") !== -1,
    'main.js does not load files-store');
  assert.ok(main.indexOf("label: 'Open files'") !== -1,
    'tray has no Open files item');
  assert.ok(/ade-files-smoke-/.test(main) && main.indexOf('if (!SMOKE)') !== -1,
    'smoke must not create the real AppData files tree');
});

'use strict';
/* Cross-file wiring pins: the mood events originate in the chat window
   (decision, failure, sentiment) and land in the glyph window. Three files
   cannot import each other, so these guards hold the bridge by source --
   the same approach as avatar-toggle.test.js. Each pin names the failure it
   prevents. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(n) { return fs.readFileSync(path.join(__dirname, '..', n), 'utf8'); }
const PRELOAD = read('preload.js');
const MAIN = read('main.js');

test('preload exposes glyphEvent and glyphTint sends', () => {
  assert.match(PRELOAD, /glyphEvent:\s*\(type\)\s*=>\s*ipcRenderer\.send\('glyph:event'/,
    'chat cannot raise a mood without glyphEvent');
  assert.match(PRELOAD, /glyphTint:\s*\(payload\)\s*=>\s*ipcRenderer\.send\('glyph:tint'/,
    'chat cannot send reply sentiment without glyphTint');
});

test('preload exposes glyph-window receivers for the relay', () => {
  assert.match(PRELOAD, /onGlyphEvent:\s*\(fn\)\s*=>\s*ipcRenderer\.on\('ui:glyphEvent'/,
    'glyph window must register the event feed');
  assert.match(PRELOAD, /onGlyphTint:\s*\(fn\)\s*=>\s*ipcRenderer\.on\('ui:glyphTint'/,
    'glyph window must register the tint feed');
});

test('main relays glyph:event to the glyph window only', () => {
  const i = MAIN.indexOf("ipcMain.on('glyph:event'");
  assert.ok(i >= 0, 'main must handle glyph:event');
  const body = MAIN.slice(i, i + 240);
  assert.match(body, /win\.isDestroyed\(\)/);
  assert.match(body, /webContents\.send\('ui:glyphEvent'/);
});

test('main relays glyph:tint to the glyph window only', () => {
  const i = MAIN.indexOf("ipcMain.on('glyph:tint'");
  assert.ok(i >= 0, 'main must handle glyph:tint');
  const body = MAIN.slice(i, i + 240);
  assert.match(body, /webContents\.send\('ui:glyphTint'/);
});
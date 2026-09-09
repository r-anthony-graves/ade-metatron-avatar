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

const CHAT = read('chat.js');

test('a decided approval raises a satisfied event', () => {
  const i = CHAT.indexOf('async function decide(m, allow)');
  assert.ok(i >= 0, 'decide() must still exist');
  const body = CHAT.slice(i, i + 900);
  assert.match(body, /glyphEvent\('approved'\)/,
    'deciding an approval must tell the glyph to be satisfied');
});

test('a failed ask raises a troubled event', () => {
  const i = CHAT.indexOf('Call failed: ');
  assert.ok(i >= 0, 'the ask failure bubble must still exist');
  const body = CHAT.slice(i, i + 300);
  assert.match(body, /glyphEvent\('failed'\)/,
    'a failed ask must tell the glyph to be troubled');
});

test('spoken replies carry their sentiment to the glyph', () => {
  const i = CHAT.indexOf('function speakText(text) {');
  assert.ok(i >= 0);
  const body = CHAT.slice(i, i + 520);
  assert.match(body, /ADE_MOOD\.sentiment\(text\)/,
    'speakText must score the reply before asking to speak');
  assert.match(body, /glyphTint\(\{[\s\S]*score[\s\S]*ms\s*:\s*4000\s*\}\)/,
    'the sentiment must cross the bridge with a speech-window duration');
});

test('a failed voice action reads raise a troubled event', () => {
  const i = CHAT.indexOf('async function runVoice(phrase, engine)');
  assert.ok(i >= 0);
  const body = CHAT.slice(i, i + 1000);
  assert.match(body, /glyphEvent\('failed'\)/,
    'a failed voice action read must tell the glyph to be troubled');
});
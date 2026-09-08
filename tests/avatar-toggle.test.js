'use strict';
/* /avatar toggles the glyph across three files that cannot import each
   other (renderer / preload / main), so these pins hold the wiring by
   reading source -- same approach as the dead-Ade-OS test. Each pin names
   the failure it prevents. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');

test('main handles glyph:toggle and recreates a closed window', () => {
  assert.ok(MAIN.includes("ipcMain.handle('glyph:toggle'"),
    'no glyph:toggle handler -- /avatar would reject in the renderer');
  const body = MAIN.split("ipcMain.handle('glyph:toggle'")[1].slice(0, 1500);
  assert.ok(body.includes('createWindow()'),
    'a closed glyph (win=null by design on close) must recreate, not fail');
  assert.ok(body.includes('getAllDisplays'),
    'showing must check the saved spot still intersects a display -- ' +
    'x:3001 with the side monitor gone was an invisible "shown"');
});

test('preload exposes glyphToggle over invoke', () => {
  assert.ok(PRELOAD.includes(
    "glyphToggle: () => ipcRenderer.invoke('glyph:toggle')"),
    'the chat window cannot reach main without the bridge entry');
});

test('the /avatar branch repeats the main-process verdict', () => {
  const m = /} else if \(cmd === 'avatar'\) \{([\s\S]*?)\n          \} else if/
    .exec(CHAT);
  assert.ok(m, 'no /avatar branch in the chain');
  assert.ok(m[1].includes('B.glyphToggle()'),
    '/avatar does not call the bridge');
  assert.ok(m[1].includes('push('),
    '/avatar must answer in the chat, success or failure');
});

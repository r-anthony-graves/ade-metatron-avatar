'use strict';
/* Menu wiring pins: the File menu and the tray menu must both restart the
   twin through the SAME `requestRestart` handler, and the application menu
   must actually be registered. Source-sniffed, like mood-wiring.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('requestRestart is defined once and posts /v1/restart', () => {
  const defs = MAIN.split('async function requestRestart()');
  assert.strictEqual(defs.length - 1, 1,
    'requestRestart() must be defined exactly once');
  const body = defs[1].slice(0, 400);
  assert.ok(body.indexOf("ade('/v1/restart'") !== -1,
    'requestRestart must post to /v1/restart');
  assert.match(body, /dialogNote/,
    'requestRestart must report through dialogNote');
});

test('the File menu carries Restart Ade OS wired to requestRestart', () => {
  const at = MAIN.indexOf('function buildAppMenu()');
  assert.ok(at >= 0, 'buildAppMenu() is not defined');
  const end = MAIN.indexOf('Menu.setApplicationMenu');
  assert.ok(end > at, 'the application menu is never registered after buildAppMenu');
  const tpl = MAIN.slice(at, end);

  const fileAt = tpl.indexOf("label: 'File'");
  assert.ok(fileAt >= 0, 'the application template must have a File menu');
  const fileEnd = tpl.indexOf("label: 'Edit'");
  const file = tpl.slice(fileAt, fileEnd);
  assert.ok(file.indexOf("label: 'Restart Ade OS…'") !== -1,
    'the File menu must carry Restart Ade OS…');
  assert.ok(file.indexOf('click: requestRestart') !== -1,
    "the File menu item must call requestRestart");
  assert.match(file, /role: 'quit'/,
    'the File menu must keep a Quit item');

  ['editMenu', 'viewMenu', 'windowMenu'].forEach(function (r) {
    assert.match(tpl, new RegExp("role: '" + r + "'"),
      'the application template must preserve the ' + r + ' role');
  });
});

test('exactly the tray item and the File item wire restart to requestRestart', () => {
  const count = MAIN.split('click: requestRestart').length - 1;
  assert.strictEqual(count, 2,
    'both the tray item and the File menu item must use click: requestRestart '
    + '(found ' + count + ')');
});

test('the application menu is registered at ready', () => {
  assert.match(
    MAIN,
    /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(buildAppMenu\(\)\)\)/,
    'setApplicationMenu must be called at ready with buildAppMenu()');
});
'use strict';
/* The chat window reopens on the tab it was left showing. Everything
   else in the Avatar already remembered itself -- the microphone, the
   glyph's arming, the breathing, the backing halo -- and the tab did
   not, so every restart put it back on Chat.

   The interesting pins here are not about saving. They are about the
   RESTORE not undoing a deliberate choice: it resolves from an async
   config read, and a tab can be demanded before that read returns. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const CHAT = read('chat.js');

test('the tab is saved, and only when it changes', () => {
  assert.match(MAIN, /tab: 'chat',/, 'no cfg default to persist into');
  assert.ok(PRELOAD.includes('tabChanged:'), 'no bridge entry');
  assert.ok(CHAT.includes('B.tabChanged(tab)'), 'the window never reports');
  const body = MAIN.split("ipcMain.on('chat:tab'")[1].slice(0, 300);
  assert.ok(body.includes('cfg.tab !== tab'),
    'this fires on every switch and saveCfg writes synchronously -- ' +
    'it must save on a CHANGE, not on every message');
  assert.ok(body.includes('saveCfg()'), 'the choice dies with the process');
});

test('the restore stands down once a tab has been chosen', () => {
  /* THE ONE THAT MATTERS. The restore comes back from an async config
     read. Without this it would undo, a moment later, whatever had
     already been picked. */
  const body = CHAT.split('B.config().then(function (c)')[1].slice(0, 300);
  assert.ok(body.includes('if (tabChosen'),
    'the restore must check whether something already chose a tab');
  assert.ok(body.includes('TABS.indexOf(c.tab) >= 0'),
    'a saved name that is no longer a tab must be refused, not applied');
});

test('an approval can never be navigated away from', () => {
  /* An approval seizes Chat and raises the window. If the restore could
     land after that, it would move Ray off a decision waiting on him --
     the single worst thing this window could do on its own. */
  /* Anchored on the approval's own push, which appears once. Splitting
     on `markApprovalsMoot();` lands on its DEFINITION -- the string is
     in this file twice, and [1] is the wrong one. */
  const body = CHAT.split("push('chat', 'ade', 'approval'")[1].slice(0, 400);
  assert.ok(body.includes('tabChosen = true'),
    'the approval path must mark the tab as chosen');
  const flag = body.indexOf('tabChosen = true');
  const seize = body.indexOf("setTab('chat')");
  assert.ok(flag >= 0 && seize > flag,
    'the flag must be set BEFORE the tab is seized, not after');
});

test('a click and a named focus both count as choosing', () => {
  /* `querySelectorAll('#tabs .tab')` is in this file twice -- once
     inside setTab, painting the active class, and once here in the
     wiring. Match the handler's own shape instead of splitting. */
  assert.match(
    CHAT,
    /addEventListener\('click', function \(\) \{\s*tabChosen = true;\s*setTab\(this\.getAttribute\('data-tab'\)\);/,
    'clicking a tab is the plainest deliberate choice there is');
  assert.ok(/if \(tab && TABS\.indexOf\(tab\) >= 0\) \{ tabChosen = true;/
    .test(CHAT),
    'a focus event naming a tab -- what --open-chat=path sends -- must ' +
    'not be undone by the restore a moment later');
});

test('only a real tab is restored', () => {
  /* `archive` is a thread but not a tab anyone picks; reopening into it
     would be confusing, and setTab would refuse it anyway. */
  assert.ok(/var TABS = \['chat', 'shell', 'path'\];/.test(CHAT),
    'the restore is bounded by TABS, so TABS is what it can restore');
});

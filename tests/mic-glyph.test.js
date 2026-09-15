'use strict';
/* "Mic drives the glyph" was typed as a checkbox while the action behind
   it was one-way, its tick was hardcoded, and it saved nothing -- so a
   restart silently dropped it and the glyph stopped answering Ray's
   voice with no error anywhere. Source-reading pins, the same approach
   as the other tests here: main, preload, ui and glyph cannot import
   each other, so the wiring has to be held across four files. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const UI = read('ui.js');
const GLYPH = read('glyph.js');

test('the setting is persisted like every checkbox around it', () => {
  /* THE ONE THAT CAUSED THIS. Click-through, Speak and Backing glow all
     read cfg and call saveCfg(); this one read nothing and saved
     nothing, so every restart turned it off. */
  assert.match(MAIN, /micGlyph: false/,
    'no cfg default -- nothing to persist into');
  const item = MAIN.split("label: 'Mic drives the glyph'")[1].slice(0, 400);
  /* ONE substring, not two windowed checks. MEASURED: a 400-char
     window past this item reaches the next menu entry (Click-through),
     which has its own saveCfg() -- so removing THIS one left the guard
     green. The pair has to be asserted as a pair. */
  assert.ok(item.includes('cfg.micGlyph = mi.checked; saveCfg();'),
    'the click must record the choice AND persist it in one breath');
});

test('the tick reads the real setting, not a hardcoded false', () => {
  const item = MAIN.split("label: 'Mic drives the glyph'")[1].slice(0, 400);
  assert.ok(!/checked: false/.test(item),
    'a hardcoded tick is a lie the moment the mic is armed');
  assert.ok(item.includes('checked: !!cfg.micGlyph'), 'the tick must read cfg');
});

test('it can be turned OFF again, not only on', () => {
  /* `GLYPH.arm()` reaches tryArm(), which is `if (!AUDIO.on) AUDIO.arm()`
     -- one-way. A checkbox whose action only goes one way is a button
     wearing a tick. `AUDIO.disarm` existed all along with no caller. */
  const item = MAIN.split("label: 'Mic drives the glyph'")[1].slice(0, 400);
  assert.ok(item.includes("'ui:arm' : 'ui:disarm'"),
    'unticking must send something, or the checkbox is decorative');
  assert.ok(PRELOAD.includes("onDisarm:"), 'no bridge entry for disarm');
  assert.ok(UI.includes('window.GLYPH.disarm()'), 'nothing calls disarm');
  assert.ok(/disarm: function\(\)\{ AUDIO\.disarm\(\); \}/.test(GLYPH),
    'GLYPH must expose disarm for ui.js to reach');
});

test('the glyph ASKS for the setting when its renderer is ready', () => {
  /* Main cannot know when the renderer has loaded. Pushing at a window
     mid-load is how a setting comes back "sometimes". */
  assert.ok(MAIN.includes("ipcMain.handle('glyph:micWanted'"),
    'no handler for the glyph to ask');
  assert.ok(PRELOAD.includes('micWanted:'), 'no bridge entry');
  assert.ok(UI.includes('B.micWanted()'), 'the glyph never asks');
  assert.ok(UI.includes('window.GLYPH.arm()'),
    'asking without arming would change nothing');
});

test('the default is off', () => {
  /* Turning a microphone on because a config file has no opinion yet is
     not a default to choose for someone. */
  assert.match(MAIN, /micGlyph: false/,
    'the mic must not arm itself on a fresh install');
});

test('renderer errors are recorded outside the smoke harness', () => {
  /* main.js already said these were invisible: "a throw in ui.js leaves
     the glyph drawing while nothing responds -- exactly the failure that
     is hardest to tell apart from it is just a picture". That capture
     lived inside startSmokeRun, so in ordinary use there was nothing to
     read. Diagnosing this bug needed it, and the empty log is what ruled
     out a renderer throw. */
  assert.ok(MAIN.includes('function watchRenderer('), 'no watcher');
  assert.ok(MAIN.includes("watchRenderer(win.webContents, 'win')"),
    'the glyph window is the one that matters most');
  assert.ok(MAIN.includes("watchRenderer(chatWin.webContents, 'chatWin')"),
    'the chat window too');
  const body = MAIN.split('function watchRenderer(')[1].slice(0, 900);
  assert.ok(body.includes('if (SMOKE) return;'),
    'a self-test must not write into the real log');
  assert.ok(body.includes('RENDERER_LOG_CAP'),
    'an uncapped log on a long-running desktop app grows without bound');
});

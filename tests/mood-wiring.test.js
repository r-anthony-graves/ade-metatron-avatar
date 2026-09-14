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

const AVATAR_HTML = read('avatar.html');
const CHAT_HTML = read('chat.html');
const UI = read('ui.js');

test('mood.js loads in the glyph window before glyph.js and ui.js', () => {
  const i = AVATAR_HTML.indexOf('<script src="glyph.js">');
  const j = AVATAR_HTML.indexOf('<script src="ui.js">');
  assert.ok(i >= 0 && j > i);
  const scripts = AVATAR_HTML.slice(0, i);
  assert.match(scripts, /mood\.js/,
    'glyph window must load mood.js (before glyph.js) so the rAF loop can pull frames');
});

test('mood.js loads in the chat window before chat.js', () => {
  const i = CHAT_HTML.indexOf('<script src="chat.js">');
  assert.ok(i >= 0);
  const before = CHAT_HTML.slice(0, i);
  assert.match(before, /mood\.js/,
    'chat window must load mood.js so speakText can score replies');
});

test('ui.js feeds the mood core from every poll', () => {
  const i = UI.indexOf('B.onState(function');
  assert.ok(i >= 0);
  const body = UI.slice(i, i + 200);
  assert.match(body, /ADE_MOOD\.feed\(s\)/,
    'every poll must re-decide the resting mood');
});

test('ui.js routes glyph events and tints into the mood core', () => {
  assert.match(UI, /B\.onGlyphEvent\(function\s*\(type\)\s*\{[\s\S]{0,80}ADE_MOOD\.event\(type\)/,
    'glyph events must reach ADE_MOOD.event');
  assert.match(UI, /B\.onGlyphTint\(function\s*\(payload\)\s*\{[\s\S]{0,80}ADE_MOOD\.tint\(payload\)/,
    'glyph tints must reach ADE_MOOD.tint');
});

test('the wake path startles the mood core', () => {
  const i = UI.indexOf('window.GLYPH.wake');
  assert.ok(i >= 0);
  const body = UI.slice(i, i + 120);
  assert.match(body, /ADE_MOOD\.event\('wake'\)/,
    'waking Ade must also flash the startled mood');
});

test('ui.js never stages non-wake speech from the Windows fallback engine', () => {
  assert.match(UI, /command === null[\s\S]{0,160}u\.engine\s*===\s*['"]windows['"]/,
    'with the whisper sidecar down, /v1/voice/listen answers from Windows ' +
    'Speech\'s closed 9-phrase grammar, which maps room tone onto stock ' +
    'commands ("stop", "check the health", "read the file"); staging that ' +
    'text would make the idle chat type its own prompts');
});

test('chat.js drops a Windows-engine dictate before it reaches the composer', () => {
  assert.match(CHAT, /ev\.dictate\s*&&[\s\S]{0,60}engine\s*===\s*['"]windows['"]/,
    'the staging site must defensively ignore a Windows-fallback dictate even ' +
    'if some other producer relays one');
});

/* ---- Task 5: glyph renderer — per-mood palettes, bursts, mode baselines ---- */

const GLYPH = read('glyph.js');

test('glyph pulls the mood frame every rAF and degrades to raw rendering', () => {
  assert.match(GLYPH, /window\.ADE_MOOD\s*&&\s*window\.ADE_MOOD\.frame/,
    'glitch must pull ADE_MOOD.frame each animation frame');
  assert.match(GLYPH, /MOODS\.mood|MOODS\[MOOD\.mood\]/,
    'the per-mood palette table must be consulted for the live mood');
  assert.match(GLYPH, /var MOODS\s*=\s*\{[\s\S]*?hot:/,
    'the per-mood palette table must define a hot colour per mood');
});

test('mood overrides the resonance target only when active', () => {
  const i = GLYPH.indexOf('ADE.step = function(dt)');
  assert.ok(i >= 0);
  const body = GLYPH.slice(i, i + 260);
  assert.match(body, /MOOD\.mood\s*\?\s*MOODS\[MOOD\.mood\]\.res/,
    'an active mood must set the energy target; idle falls back to raw state logic');
});

test('the core leans on the mood palette for HOT and MID', () => {
  const i = GLYPH.indexOf('function drawCore(t, u, res, asm)');
  assert.ok(i >= 0);
  const body = GLYPH.slice(i, i + 560);
  assert.match(body, /MOOD\.mood\s*\?\s*MOOD\.hot/,
    'an active mood must color the core HOT');
  assert.match(body, /MOOD\.mood\s*\?\s*MOOD\.mid/,
    'an active mood must color the core MID');
});

test('startle and satisfy ride the base size through MOOD.burst', () => {
  const i = GLYPH.indexOf('function drawCore(t, u, res, asm)');
  const body = GLYPH.slice(i, i + 1750);
  assert.match(body, /MOOD\.burst/,
    'burst must feed the core base so events visibly flash');
});

test('the volumetric halo follows the mood palette when active', () => {
  const i = GLYPH.indexOf('function drawVolumetrics(t, res, asm)');
  assert.ok(i >= 0);
  const body = GLYPH.slice(i, i + 400);
  assert.match(body, /MOOD\.mood/,
    'mood must tint the halo');
});

test('mode baselines exist in the preset surface', () => {
  assert.match(GLYPH, /'ask-first'/,
    'the ask-first baseline (fixed ring) must be present');
  assert.match(GLYPH, /'dev'/,
    'the dev metronome baseline must be present');
});

test('_state reports mood, mode, burst and tint', () => {
  const i = GLYPH.indexOf('_state: function()');
  assert.ok(i >= 0);
  const body = GLYPH.slice(i, i + 300);
  ['mood:', 'mode:', 'burst:', 'tint:'].forEach(function (k) {
    assert.match(body, new RegExp(k), '_state must expose ' + k);
  });
});

/* ---- Task 6: autonomous mode setting (tray radio + state payload) ---- */

test('cfg defaults to auto mode', () => {
  const i = MAIN.indexOf('let cfg = {');
  assert.ok(i >= 0);
  const body = MAIN.slice(i, i + 200);
  assert.match(body, /mode:\s*'auto'/,
    'an existing config without the key must still read as auto mode');
});

test('poll state carries the mode to both windows', () => {
  const i = MAIN.indexOf('state = { online, busy, pending, brain, approval');
  assert.ok(i >= 0);
  assert.match(MAIN.slice(i, i + 90), /mode:\s*cfg\.mode/,
    'the ade:state payload must include the operating mode');
});

test('the tray menu exposes the three modes', () => {
  assert.match(MAIN, /label:\s*'Mode'/,
    'a Mode submenu must exist in the tray');
  ['auto', 'ask-first', 'dev'].forEach(function (m) {
    assert.match(MAIN, new RegExp('cfg.mode = \'' + m + '\''),
      'the tray must be able to set mode ' + m);
  });
  assert.match(MAIN, /type:\s*'radio'/,
    'the mode menu must be a radio group');
});
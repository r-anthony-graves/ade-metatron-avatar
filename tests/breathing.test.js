'use strict';
/* "stop the gliph from fading in and out" -- Ray, 2026-09-15.
 *
 * The fading is the glyph's breathing: a sine oscillator scaling the
 * core's brightness every frame, at an amplitude the current mood picks.
 * The window's own opacity is static, so nothing else was fading.
 *
 * These pins hold two things: that it can be switched off and stays off
 * across a restart, and that switching it off does NOT silence the
 * glyph's event bursts, which are the orb earning its place. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const UI = read('ui.js');
const GLYPH = read('glyph.js');

test('breathing can be turned off, and the choice is saved', () => {
  assert.match(MAIN, /breathe: true,/, 'no cfg default to persist into');
  const item = MAIN.split("label: 'Breathing'")[1].slice(0, 400);
  assert.ok(item.includes('cfg.breathe = mi.checked; saveCfg();'),
    'the click must record the choice AND persist it, in one breath -- ' +
    'the mic setting was lost for exactly this reason');
  assert.ok(item.includes("checked: cfg.breathe !== false"),
    'the tick must read the saved value, not a hardcoded one');
  assert.ok(item.includes("send('ui:breathe'"), 'the glyph is never told');
});

test('the change reaches the glyph live AND at load', () => {
  /* Live only would mean it came back breathing after every restart.
     Load only would mean the tray tick did nothing until you restarted. */
  assert.ok(PRELOAD.includes('onBreathe:'), 'no bridge entry');
  assert.ok(UI.includes('B.onBreathe(function (on)'), 'no live listener');
  assert.ok(UI.includes('window.GLYPH.setBreathe(c.breathe !== false)'),
    'the glyph must read the setting through B.config() at load');
  assert.ok(/setBreathe: function\(on\)\{ ADE\.breathe = !!on; \}/.test(GLYPH),
    'GLYPH must expose the setter ui.js calls');
});

test('off means STEADY, not dim', () => {
  /* Amplitude zero leaves the multiplier at exactly 1, so the core keeps
     the size and brightness its mood and the live audio give it. Zeroing
     the whole `breathe` term instead would black the core out. */
  const body = GLYPH.split('var breatheAmp')[1].slice(0, 400);
  assert.ok(body.includes('ADE.breathe === false ? 0'),
    'switching off must zero the AMPLITUDE, nothing else');
  assert.match(GLYPH, /var breathe = flickK \* \(1 \+ breatheAmp \* pulse/,
    'the amplitude must sit inside a 1 + ... term, or zero goes dark');
});

test('bursts and the microphone still move the core', () => {
  /* Ray asked for the idle pulse to stop, not for the orb to stop
     meaning anything. An approval arriving or a step failing still
     swells it, and so does his voice. */
  /* Anchored on the CORE's own line, not on a positional split:
     there are two "var base = " in this file and the first is a
     starfield dot, which my first version of this test read instead. */
  const line = GLYPH.split('14.5*S*(focal/900)')[1].slice(0, 220);
  assert.ok(line.includes('MOOD.burst'), 'event bursts were removed');
  assert.ok(line.includes('MOOD.ember'), 'the ember was removed');
  assert.ok(line.includes('AUDIO.flash'), 'the live microphone was removed');
});

test('the default is that it breathes', () => {
  /* This turns the piece off for someone who asked, rather than
     changing what the Avatar is for everyone. */
  assert.match(MAIN, /breathe: true,/, 'the piece is the default');
  assert.match(GLYPH, /backing:true, breathe:true,/,
    'the renderer must also default to breathing, for a config with no ' +
    'opinion yet');
});

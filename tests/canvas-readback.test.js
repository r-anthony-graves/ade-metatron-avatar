'use strict';
/* The renderer log says, twice per session:
 *
 *   [ui.js:110] Canvas2D: Multiple readback operations using getImageData
 *   are faster with the willReadFrequently attribute set to true.
 *
 * It points at ui.js and it is wrong about it. Context attributes are
 * fixed by the FIRST getContext on a canvas; glyph.js:14 already took
 * this one, and glyph.js loads before ui.js in avatar.html. Adding the
 * flag where the warning points changes nothing while looking like a
 * fix -- MEASURED in Chromium: the second getContext returns the same
 * object and willReadFrequently stays false.
 *
 * These pins exist so the next person to read that log does not spend
 * the afternoon I spent, and does not land a no-op believing it worked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const UI = read('ui.js');
const GLYPH = read('glyph.js');
const AVATAR_HTML = read('avatar.html');

test('glyph.js takes the canvas context before ui.js sees it', () => {
  /* The load order IS the reason the warning is misdirected. If these
     ever swap, ui.js becomes the first caller and its attributes would
     suddenly govern the glyph's whole render surface -- which is a
     change nobody would mean to make by reordering two script tags. */
  const g = AVATAR_HTML.indexOf('glyph.js');
  const u = AVATAR_HTML.indexOf('ui.js');
  assert.ok(g > -1 && u > -1, 'both scripts must be loaded');
  assert.ok(g < u,
    'glyph.js must load first -- it owns the context attributes');
  assert.match(GLYPH, /var ctx\s*=\s*cvs\.getContext\('2d',\s*\{ alpha: AVATAR \}\)/,
    'glyph.js is the first getContext and sets the real attributes');
});

test('ui.js does not ask for willReadFrequently, and says why', () => {
  const probe = UI.split("var probe = cvs.getContext")[0].slice(-1400);
  assert.ok(!/willReadFrequently:\s*true/.test(
    UI.split('var probe = cvs.getContext')[1].slice(0, 80)),
    'asking here is a no-op: the context already exists');
  assert.ok(probe.includes('MEASURED'),
    'the reason must travel with the line, or it gets "fixed" again');
});

test('the hit-test readback stays small and throttled', () => {
  /* What makes the warning not worth acting on: 11x11 pixels, only on
     mousemove, at most once per 16ms. If any of those grow, the trade
     changes and the flag deserves reconsidering on glyph.js:14. */
  assert.match(UI, /var HIT_PAD = 5;/,
    'the probe reads (2*PAD+1)^2 pixels -- 11x11 at PAD 5');
  assert.match(UI, /if \(now - hitAt < 16\) return;/,
    'the readback must stay throttled to one frame');
  assert.ok(UI.includes('getImageData(x, y, n, n)'),
    'it must read the small region, never the whole surface');
});

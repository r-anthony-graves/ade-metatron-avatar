'use strict';
/* The Path tab frames a separate project, so the pins that matter here are
   about CONTAINMENT and about not breaking the two tabs that already
   worked. Same source-reading approach as the other tests in this folder:
   renderer HTML, renderer JS and the CSP cannot import each other.

   The Path lives at C:\Users\ray_g\the-path and stays separate -- the
   `companion` agent owns no code there and reaches it only by running its
   CLI the way a person would. This tab is that same posture in a window:
   it knows a URL and nothing else. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'chat.html'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');

const CSP = (HTML.match(/Content-Security-Policy[\s\S]*?content="([^"]*)"/) || [])[1] || '';

test('the CSP frames The Path and nothing else', () => {
  assert.ok(CSP, 'no CSP found -- the renderer would have no policy at all');
  assert.ok(CSP.includes('frame-src http://127.0.0.1:8412'),
    'without frame-src the panel is blocked by default-src none and ' +
    'shows an empty box with no error a user can act on');
});

test('the CSP does NOT let this renderer frame Ade OS', () => {
  /* THE ONE THAT MATTERS. `http://127.0.0.1:*` was the tempting
     shortcut when the port looked variable. It is not variable -- The
     Path pins 8412 in path/app/__init__.py with a comment saying "Not
     8000 and not 8300. 8300 is Ade OS" -- and a wildcard would let this
     window embed Ade OS's own API surface, which is the single thing it
     must not be able to frame. */
  const frameSrc = (CSP.match(/frame-src ([^;]*)/) || [])[1] || '';
  assert.ok(!frameSrc.includes('*'),
    'a wildcard loopback origin would also allow framing Ade OS on 8300');
  assert.ok(!frameSrc.includes('8300'),
    'Ade OS must never be framable by its own chat renderer');
  assert.equal(frameSrc.trim(), 'http://127.0.0.1:8412',
    'exactly one origin, named');
});

test('the tab is registered as well as drawn', () => {
  assert.ok(HTML.includes('data-tab="path"'),
    'no button -- the tab cannot be reached');
  assert.ok(/var TABS = \[[^\]]*'path'/.test(CHAT),
    "setTab falls back to 'chat' for any tab not in TABS, so a button " +
    'without a TABS entry silently does nothing when clicked');
});

test('renderThread survives a tab that is a panel, not a conversation', () => {
  /* `threads` holds chat/shell/archive. `path` has no thread, and
     `renderThread` runs on EVERY tab switch -- reading
     `threads.path.length` would throw and leave the UI stuck. */
  const body = CHAT.split('function renderThread()')[1].slice(0, 400);
  assert.ok(/if \(!list\) return;/.test(body),
    'renderThread must return early for a tab with no thread');
});

test('the frame loads nothing until the tab is opened', () => {
  assert.ok(HTML.includes('src="about:blank"'),
    'a src pointing at The Path on load would poke a server that may ' +
    'not be running, every time the Avatar starts');
  assert.ok(CHAT.includes("getAttribute('src') === 'about:blank'"),
    'nothing promotes the frame off about:blank on first open');
});

test('switching to Path hides the thread and back again', () => {
  const body = CHAT.split('function showPath(')[1].slice(0, 400);
  assert.ok(body.includes('pathEl.hidden = !on'), 'the panel never shows');
  assert.ok(body.includes('threadEl.hidden = on'),
    'the conversation would render underneath or on top of the frame');
  assert.ok(CHAT.includes("showPath(tab === 'path')"),
    'setTab must drive it, or the panel and the tab bar disagree');
});

test('every sub-tab names a real route of The Path', () => {
  /* Kept deliberately small and literal. These are the app's own nav
     entries; a typo here is a 404 inside the frame with nothing in the
     Avatar to explain it. */
  const routes = [...HTML.matchAll(/data-route="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(routes, ['/', '/diary', '/read', '/study',
                            '/catalogue', '/stage']);
});

test('the panel says what to do when The Path is not running', () => {
  /* A cross-origin frame cannot report a load failure to its parent, so
     there is no honest way to detect this. A blank panel with no
     explanation reads as a broken Avatar, so the requirement is stated
     permanently instead of pretended at. */
  assert.ok(/id="path-note"/.test(HTML), 'no note element');
  assert.ok(/thepath serve/.test(HTML),
    'the note must name the command that fixes a blank panel');
});

test('the hint says where writing actually goes', () => {
  /* The footer input is the same box on every tab and still asks Ade.
     A text box sitting under a workbook page invites the assumption
     that typing there writes an entry. */
  assert.ok(CHAT.includes('this box still asks Ade'),
    'the Path hint must disown the input, or Ray will write into it');
});

'use strict';
/* `--open-chat=<tab>` opens a named tab, including on an instance that is
   already running. Everything needed was here and one argument short:
   openChat(tab) already forwards the tab as chat:focus, and the renderer
   already does `if (tab && TABS.indexOf(tab) >= 0) setTab(tab)`. What was
   missing was any way to say WHICH from outside. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MAIN = read('main.js');
const CHAT = read('chat.js');

/* The parser, lifted out of main.js so its behaviour is tested rather
   than asserted about. Kept byte-identical to the source below. */
function tabFromArgv(argv) {
  const hit = (argv || []).find((a) => a.startsWith('--open-chat='));
  return hit ? hit.slice('--open-chat='.length) : null;
}

test('the extracted parser matches the one in main.js', () => {
  /* A copy of logic in a test is a lie waiting to happen. This asserts
     the source still contains the same body the cases below exercise. */
  assert.ok(MAIN.includes(
    "const hit = (argv || []).find((a) => a.startsWith('--open-chat='));"),
    'main.js parser changed -- update the copy in this test');
  assert.ok(MAIN.includes("return hit ? hit.slice('--open-chat='.length) : null;"),
    'main.js parser changed -- update the copy in this test');
});

test('a tab is read from argv, and its absence is not a guess', () => {
  assert.equal(tabFromArgv(['electron', '.', '--open-chat=path']), 'path');
  assert.equal(tabFromArgv(['electron', '.', '--open-chat=shell']), 'shell');
  /* Bare --open-chat still means "just open the window", as before. */
  assert.equal(tabFromArgv(['electron', '.', '--open-chat']), null);
  assert.equal(tabFromArgv(['electron', '.']), null);
  assert.equal(tabFromArgv(undefined), null);
  /* An unknown name is passed through and REFUSED downstream rather than
     guessed at -- the renderer checks it against TABS. */
  assert.equal(tabFromArgv(['--open-chat=nonsense']), 'nonsense');
});

test('the second instance uses the argv it was handed', () => {
  /* THE ONE THAT MATTERS. The single-instance lock means a second launch
     does not start a second copy -- it wakes the running one, and
     Electron hands that handler the waking argv. It was being discarded,
     so `electron . --open-chat=path` raised the window on whatever tab
     happened to be showing. */
  const body = MAIN.split("app.on('second-instance'")[1].slice(0, 200);
  assert.ok(/\(_e, argv\)/.test(body),
    'the handler must accept the argv Electron passes it');
  assert.ok(body.includes('openChat(tabFromArgv(argv))'),
    'the waking argv must decide the tab');
});

test('the first instance honours the same flag', () => {
  const body = MAIN.split('const wantsChat')[1].slice(0, 300);
  assert.ok(body.includes("a === '--open-chat'"),
    'bare --open-chat must keep working');
  assert.ok(body.includes("a.startsWith('--open-chat=')"),
    'the =tab form must also trigger the window');
  assert.ok(body.includes('openChat(tab)'), 'the tab must be passed through');
});

test('the renderer refuses a tab it does not have', () => {
  /* The safety half: an unknown name must not blank the window.

     Matched as a PROPERTY, not as exact wording. This was pinned to the
     literal line and broke the day that line gained a tabChosen flag
     beside its setTab call -- the check it guards was untouched. A guard
     that fires on a rewording it does not care about gets loosened by
     whoever it annoys, which is how real guards get lost. */
  assert.match(CHAT, /if \(tab && TABS\.indexOf\(tab\) >= 0\)[^\n]*setTab\(tab\)/,
    'chat:focus must check the name against TABS before switching');
  assert.ok(/if \(allTabs\(\)\.indexOf\(tab\) < 0\) tab = 'chat';/.test(CHAT),
    'setTab must fall back to chat for anything unknown');
});

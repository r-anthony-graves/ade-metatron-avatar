'use strict';
/* The Journal tab. Ray, 2026-09-07: "i want a dedicated tab for journal" --
   in the Avatar, not the workspace -- and then "where do the writing prompts
   go", which is the question this tab exists to answer. Before it, the Codex
   raised a prompt at /v1/codex/invitation and took the reply at
   /v1/codex/reflect/{id}/answer, and both were reachable only by curl.

   Structural guards, matching this suite's style: the source is read and
   checked, because there is no DOM harness here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'chat.html'), 'utf8');

/* Comments and string literals out, so a guard reads CODE and not the prose
   explaining it. Three guards in the sibling suite have fired on English. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\n]|\.)*'/g, "''")
    .replace(/"(?:[^"\\n]|\.)*"/g, '""');
}
const CODE = codeOnly(JS);

test('the tab exists in the markup', () => {
  assert.match(HTML, /data-tab="journal"/);
});

test('journal is NOT a thread tab', () => {
  /* `threads` is keyed by TABS and several loops walk `threads[TABS[t]]` to
     compact, archive and count. A tab with no thread behind it would read
     undefined in five places -- and the journal is the Codex's own record,
     not a conversation: pushing fetched entries into a persisted thread would
     duplicate every entry each time the tab was opened.

     Falsified by adding 'journal' to TABS. */
  const tabs = CODE.match(/var TABS = \[([^\]]*)\]/);
  assert.ok(tabs, 'TABS declaration not found');
  assert.doesNotMatch(tabs[1], /journal/);
  assert.match(CODE, /var READ_TABS = \[/);
});

test('setTab accepts the read tabs, or the tab is unreachable', () => {
  /* setTab began `if (TABS.indexOf(tab) < 0) tab = 'chat'`, which silently
     bounces any tab not in TABS. Falsified by reverting that line. */
  assert.match(CODE, /function setTab[\s\S]{0,200}allTabs\(\)\.indexOf/);
});

test('the journal is fetched fresh, never cached into threads', () => {
  /* It changes on its own schedule -- the rhythms write it -- so a stored
     copy goes stale between passes. Falsified by pushing entries into
     `threads`. */
  assert.match(CODE, /\/v1\/codex\/journal/);
  const render = CODE.slice(CODE.indexOf('function renderJournal'),
                            CODE.indexOf('function paintJournal'));
  assert.doesNotMatch(render, /threads\[/);
});

test('a degraded entry is rendered, not hidden', () => {
  /* adeos/codex/journal.py's own rule: an empty day and an unreachable engine
     must never read the same. This view would break it by showing prose
     either way, so it renders whatever body the entry carries rather than
     filtering. Falsified by dropping entries on a flag. */
  assert.doesNotMatch(CODE, /entries\.filter/);
  assert.match(CODE, /entry\.body/);
});

test('the writing prompt is surfaced', () => {
  /* Ray: "where do the writing prompts go". Nowhere, until this.
     Falsified by removing the invitation fetch. */
  assert.match(CODE, /\/v1\/codex\/invitation/);
  assert.match(CODE, /function promptCard/);
});

test('a missing invitation does not take the journal down with it', () => {
  /* A journal that will not render because the Codex had nothing to ask is
     worse than a journal with no prompt at the top. Falsified by removing the
     per-call catch. */
  const fetchBlock = CODE.slice(CODE.indexOf('Promise.all'),
                                CODE.indexOf('function paintJournal'));
  assert.match(fetchBlock, /invitation[\s\S]{0,160}catch/);
});

test('the answer goes to the reflection that ASKED', () => {
  /* `answer_at` comes with the invitation and is held, so a pass that opened
     a different question in between cannot receive this answer. Falsified by
     re-fetching the invitation at submit time, or by hardcoding a path. */
  assert.match(CODE, /var standingPrompt/);
  assert.match(CODE, /answer_at/);
  const handler = CODE.slice(CODE.indexOf('async function handleJournalAnswer'),
                             CODE.indexOf('var busy = false'));
  assert.match(handler, /B\.call\(c\.at,/);
  assert.doesNotMatch(handler, /\/v1\/codex\/reflect\//);
});

test('the composer only answers when there is something to answer', () => {
  /* Otherwise the text vanishes into a view with no target. Falsified by
     routing every journal-tab message to the answer path. */
  /* Read from the RAW source, not from `codeOnly`. The construct being
     checked contains a string literal by nature, and stripping literals to
     look for one is self-defeating -- it desynced here on the first run and
     left 'journal' intact while removing 'shell' two lines above. */
  const route = JS.slice(JS.indexOf('function routePlain'),
                         JS.indexOf('window.__routePlain'));
  assert.match(route, /activeTab === 'journal'\s*&&\s*standingPrompt\s*&&\s*standingPrompt\.answer_at/);
});

test('answering re-reads rather than patching the view', () => {
  /* Answering may close the reflection, open the next rung, or raise
     something else entirely, and only the server knows which. Falsified by
     mutating the DOM instead of calling renderJournal. */
  const handler = CODE.slice(CODE.indexOf('async function handleJournalAnswer'),
                             CODE.indexOf('var busy = false'));
  assert.match(handler, /renderJournal\(\)/);
});

test('a failed answer says so instead of looking accepted', () => {
  const handler = CODE.slice(CODE.indexOf('async function handleJournalAnswer'),
                             CODE.indexOf('var busy = false'));
  assert.match(handler, /catch/);
  assert.match(handler, /not recorded/);
});

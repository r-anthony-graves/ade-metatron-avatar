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

test('journal and invitation are read through the .data envelope', () => {
  /* `adeBridge.call` resolves to { ok, status, data } -- every sibling site
     unwraps `.data` (r.data.types, r.data.codex). renderJournal once read
     `r.entries` and `inv.invitation` directly, which are always undefined:
     the entries and the standing invitation both rendered empty even though
     the server answered. Falsified by reverting to the raw fields. */
  const render = CODE.slice(CODE.indexOf('function renderJournal'),
                            CODE.indexOf('function paintJournal'));
  assert.match(render, /r\.data\.entries/);
  assert.match(render, /inv\.data\.invitation/);
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

test('the answer is sent under the key the endpoint reads', () => {
  /* adeos/codex/api.py reads body.get("answer", ""); the tab once POSTed
     { text: c.text }, so the server received an empty answer and the ladder
     treated every reply as a deflection. The /reflect slash command sends
     { answer: body } -- this path must agree. Falsified by renaming the key
     back to `text` (or sending the reply under any other name). */
  const handler = CODE.slice(CODE.indexOf('async function handleJournalAnswer'),
                             CODE.indexOf('var busy = false'));
  assert.match(handler, /B\.call\(c\.at,[\s\S]{0,60}answer:/);
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

/* ----------------------------------------------------------------------- */
/* The workbook card (Plan Task 7). Each guard matches the existing
   source-guard style: read the CODE, check the load-bearing construct. */
/* ----------------------------------------------------------------------- */

test('the workbook speaks per kind (FRAMING has all four)', () => {
  /* One card, rendered by the invitation's kind, and each kind gets Ade's
     own framing line -- not a generic "The Codex is asking". Guarded on the
     raw JS: codeOnly's quote-stripper eats a key that sits between two
     surviving strings (puzzle:), so a stripped guard would be checking a
     corpse. Falsified by dropping a key from FRAMING. */
  const framing = JS.slice(JS.indexOf('var FRAMING'),
                           JS.indexOf('function frameFor'));
  assert.match(framing, /quest:/);
  assert.match(framing, /reflection:/);
  assert.match(framing, /pattern:/);
  assert.match(framing, /puzzle:/);
});

test('unfold pulls the kind\'s own detail route', () => {
  /* The workbook reveals *why* from each kind's detail endpoint, never from
     a hardcoded summary. Guarded on the raw JS: codeOnly makes every case
     arm collapse (quest's arm) or survive (reflection's, which holds an n),
     and eats `case 'puzzle'` outright -- a stripped guard would pass an
     empty field. Falsified by removing one route. */
  const route = JS.slice(JS.indexOf('function detailRouteFor'),
                         JS.indexOf('function promptCard'));
  const arms = (route.match(/case '(?:quest|reflection|pattern|puzzle)':/g) || []);
  assert.deepEqual(arms, [
    "case 'quest':",
    "case 'reflection':",
    "case 'pattern':",
    "case 'puzzle':"
  ]);
  assert.match(route, /standingPrompt\.slug/);
  assert.match(route, /\/v1\/codex\/quests\//);
  assert.match(route, /\/v1\/codex\/reflect\//);
  assert.match(route, /\/v1\/codex\/patterns/);
  assert.match(route, /\/v1\/codex\/puzzles\//);
  assert.match(route, /default: return null/);
});

test('unrevealed quest clues are a count, never their text', () => {
  /* quests.py burns a clue by serving it, so the workbook's quest unfold
     must rate the depth by clues_unrevealed -- not by interpolating a clue's
     body. Falsified by interpolating clue text. */
  const unfold = CODE.slice(CODE.indexOf('function unfoldedProse'),
                            CODE.indexOf('function sendWorkbook'));
  assert.match(unfold, /clues_unrevealed/);
  assert.doesNotMatch(unfold, /\.clues\b/);
  assert.doesNotMatch(unfold, /\.clues\.\w+\.text/);
});

test('the workbook date comes from the journal, not the client clock', () => {
  /* The journal tab's own rule: the server period_key is the date, because
     the client clock drifts and the quest must not re-date itself. Falsified
     by inserting new Date() into the workbook path. */
  const workbook = CODE.slice(CODE.indexOf('function paintJournal'),
                              CODE.indexOf('function journalEntry'));
  assert.match(workbook, /period_key/);
  assert.doesNotMatch(workbook, /new Date/);
});

test('the submit maps one payload per kind', () => {
  /* quest -> { response, noticed, deepen }; reflection -> { answer };
     pattern -> { decision, null_hypothesis, rejected_because };
     puzzle -> { attempt }. Falsified by routing every kind to { answer }. */
  const mapper = CODE.slice(CODE.indexOf('function workbookBody'),
                            CODE.indexOf('function detailRouteFor'));
  assert.match(mapper, /response:/);
  assert.match(mapper, /answer:/);
  assert.match(mapper, /decision:/);
  assert.match(mapper, /attempt:/);
});

test('Ade speaks in the workbook', () => {
  /* The framework line and the confirmation after a submit are Ade's own
     voice, not boilerplate. Falsified by removing the confirmation call. */
  const workbook = CODE.slice(CODE.indexOf('function sendWorkbook'),
                              CODE.indexOf('function journalEntry'));
  assert.match(workbook, /speakText\(/);
  assert.match(workbook, /enterred below the surface\./);
});

test('the journal subtab bar has every kind', () => {
  /* Each workbook kind owns a subtab, and Entries keeps the journal. A kind
     with no button is a panel with no entrance. Falsified by dropping one
     data-jtab button from the markup. */
  for (const kind of ['quest', 'reflection', 'pattern', 'puzzle', 'entries']) {
    assert.match(HTML, new RegExp('data-jtab="' + kind + '"'));
  }
  assert.match(HTML, /id="jtab"/);
});

test('the workbook is styled', () => {
  /* Tasks 6-7 shipped the card with no CSS; the live card rendered as bare
     textareas and buttons. This pins the stylesheet the card and its panels
     are drawn with. Falsified by deleting the workbook CSS block. */
  assert.match(HTML, /\.workbook\s*\{/);
  assert.match(HTML, /\.wb-framing/);
  assert.match(HTML, /\.wb-field/);
  assert.match(HTML, /#jtab/);
});

test('the live kind owns the dot and is auto-selected', () => {
  /* Opening the journal greets the owed thing: the invitation's kind gets a
     live dot and, when no panel was chosen yet, becomes the active kind.
     Falsified by removing the `activeKind = live` auto-select line or by
     never toggling the `.live` class. */
  /* Read from the RAW source, not from `codeOnly`: the toggle's `'live'`
     literal has no 'n', so codeOnly strips it to `toggle('', ...)` -- same
     trap as the 'n'-less route guards and the FRAMING guard. */
  const pj = JS.slice(JS.indexOf('function paintJournal'),
                      JS.indexOf('function journalEntry'));
  assert.match(pj, /classList\.toggle\('live'/);
  assert.match(pj, /standingPrompt\.kind/);
  assert.match(pj, /activeKind = live/);
});

test('panels dispatch per kind', () => {
  /* One panel per kind, one Entries default -- a kind with no case is a
     panel that never renders. Guarded on the RAW JS: codeOnly eats
     `case 'puzzle'` (same trap as the FRAMING guard). Falsified by removing
     one case arm. */
  const dispatch = JS.slice(JS.indexOf('function journalPanel'),
                            JS.indexOf('function questHistoryPanel'));
  const arms = (dispatch.match(/case '(?:quest|reflection|pattern|puzzle)':/g) || []);
  assert.deepEqual(arms, [
    "case 'quest':",
    "case 'reflection':",
    "case 'pattern':",
    "case 'puzzle':"
  ]);
  assert.match(dispatch, /paintEntries\(entries\)/);
});

test('each kind panel reads its own history route', () => {
  /* History comes from the kind's own read endpoint, never a shared fetch
     that a new kind could silently join. Guarded on the RAW JS: codeOnly
     strips the n-less route literals ('/v1/codex/quests'/reflect/puzzles)
     to '' -- same trap as the FRAMING and detailRouteFor guards, which
     are the precedent for reading JS here. Falsified by removing one
     route string from the panel block. */
  const panels = JS.slice(JS.indexOf('function questHistoryPanel'),
                          JS.indexOf('function paintEntries'));
  assert.match(panels, /\/v1\/codex\/quests/);
  assert.match(panels, /\/v1\/codex\/reflect/);
  assert.match(panels, /\/v1\/codex\/patterns/);
  assert.match(panels, /\/v1\/codex\/puzzles/);
});

test('the quest board rates depth by clue COUNT, never a clue body', () => {
  /* Serving a clue's text is what reveals it (quests.py), so the board's
     unrevealed figure must come from `clues_unrevealed`, never by walking
     the revealed list. Falsified by replacing the field with
     `(n.clues || []).length`. */
  const board = CODE.slice(CODE.indexOf('function questHistoryPanel'),
                           CODE.indexOf('function reflectionHistoryPanel'));
  assert.match(board, /clues_unrevealed/);
  assert.doesNotMatch(board, /\.clues\.\w+\.text/);
});

test('a recorded workbook flips to the done card', () => {
  /* The mockup's dimmed confirmation replaces the card in place -- Ade
     confirms, and the refetch on the next switch re-settles everything
     else. Falsified by removing the done-flip. */
  const wb = CODE.slice(CODE.indexOf('function sendWorkbook'),
                        CODE.indexOf('function journalEntry'));
  assert.match(wb, /classList\.add\('done'\)/);
  assert.match(wb, /never a verdict/);
});

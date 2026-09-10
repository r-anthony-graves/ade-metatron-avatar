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
/* The workbook card. Each guard matches the existing source-guard style:
   read the CODE, check the load-bearing construct. */
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
  /* A section with no button is a panel with no entrance. The five Codex
     kinds owned these buttons until 2026-09-09; they now FOLD under the
     sections (see the FOLD table) and the six sections own the bar.

     Falsified by dropping one data-jtab button from the markup. */
  for (const section of ['intent', 'gateway', 'vision', 'analysis',
                         'integration', 'review']) {
    assert.match(HTML, new RegExp('data-jtab="' + section + '"'));
  }
  assert.match(HTML, /id="jtab"/);
});

test('the workbook is styled', () => {
  /* The card shipped once with no CSS at all, and the live version rendered
     as bare textareas and buttons. This pins the stylesheet the card and its
     panels are drawn with. Falsified by deleting the workbook CSS block. */
  assert.match(HTML, /\.workbook\s*\{/);
  assert.match(HTML, /\.wb-framing/);
  assert.match(HTML, /\.wb-field/);
  assert.match(HTML, /#jtab/);
});

test('the live kind owns the dot and is auto-selected', () => {
  /* Opening the journal greets the owed thing: the invitation's kind gets a
     live dot and, until a panel is actually chosen, becomes the active kind
     (an auto-select is not a choice -- userPickedKind stays false, so the
     greeting re-runs on every entry). With nothing owed, the quiet Entries
     default. Falsified by removing the `activeKind = live` auto-select line,
     by dropping the `|| 'entries'` fallback, or by never toggling the
     `.live` class.

     Since 2026-09-09 the greeting lands on the SECTION the owed kind folds
     to, and the quiet default is the first section rather than the retired
     Entries panel. The auto-select itself is unchanged, and so is the reason
     it re-runs: userPickedKind stays false. */
  /* Read from the RAW source, not from `codeOnly`: the toggle's `'live'`
     literal has no 'n', so codeOnly strips it to `toggle('', ...)` -- same
     trap as the 'n'-less route guards and the FRAMING guard. */
  const pj = JS.slice(JS.indexOf('function paintJournal'),
                      JS.indexOf('function journalEntry'));
  assert.match(pj, /classList\.toggle\('live'/);
  assert.match(pj, /FOLD\[standingPrompt\.kind\]/,
    'the dot no longer follows the fold');
  assert.match(pj, /activeKind = live/);
  assert.match(pj, /\|\s*'intent'/);
});

test('panels dispatch per kind', () => {
  /* One panel per kind, one Entries default -- a kind with no case is a
     panel that never renders. Guarded on the RAW JS: codeOnly eats
     `case 'puzzle'` (same trap as the FRAMING guard). Falsified by removing
     one case arm. */
  /* The switch is gone: every kind is a SECTION now and one dispatch serves
     all six, with the Codex's own history folded in beneath. What the guard
     was ever about -- a kind that reaches no panel never renders -- is kept:
     the dispatch must exist, and every folded kind must reach a panel.

     Falsified by removing the dispatch, or by dropping a fold. */
  const dispatch = JS.slice(JS.indexOf('function journalPanel'),
                            JS.indexOf('function sectionPanel'));
  assert.match(dispatch, /sectionPanel\(activeKind/);

  const fold = JS.slice(JS.indexOf('function foldedHistory'),
                        JS.indexOf('function questHistoryPanel'));
  for (const panel of ['questHistoryPanel', 'reflectionHistoryPanel',
                       'patternHistoryPanel', 'puzzleHistoryPanel',
                       'paintEntries']) {
    assert.match(fold, new RegExp(panel + '\\('),
      panel + ' is folded under no section');
  }
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

test('the journal command opens the tab and says nothing about trading', () => {
  /* The tab means the Codex journal -- Adé's own record, and now the
     Pathwork's. The slash command still described a trade journal and
     answered with a stub line, so one window carried two meanings of the
     word a keystroke apart. It also declared `stub: false` while its handler
     printed "stub command", which is a third disagreement.

     Read from the RAW JS, not from codeOnly's output: the point of this
     guard is the string literals themselves.

     Falsified by restoring the "Trade journal" stub line. */
  const entry = JS.match(/\{ name: 'journal', hint: '([^']*)'/);
  assert.ok(entry, 'no journal entry in the command list');
  assert.doesNotMatch(entry[1], /trade/i);

  const at = JS.indexOf("cmd === 'journal'");
  assert.ok(at > 0, 'no journal branch in the command handler');
  /* To the next branch, not a fixed window -- a comment inside this one
     pushed setTab past a 320-char slice and reddened the guard for the
     wrong reason. */
  const next = JS.indexOf('else if (cmd ===', at + 20);
  const branch = JS.slice(at, next > at ? next : at + 800);
  assert.match(branch, /setTab\('journal'\)/);
  assert.doesNotMatch(branch, /trade/i);
});

/* --------------------------------------------------------------------------
   The Thought for the Day, and the frontier. Ray, 2026-09-09.

   The thought STANDS ALONE: read every morning whether or not a session
   follows, so it is not a header on one panel -- it renders above whichever
   subtab is open. The frontier beneath it is what a session targets, and it
   is READ rather than chosen.
   -------------------------------------------------------------------------- */

test('the journal reads the thought and the position', () => {
  /* Both routes are n-less or nearly so, and codeOnly strips string literals
     lacking `n` -- '/v1/codex/thought' has no n at all and would vanish. Read
     the RAW JS, like the FRAMING and detailRouteFor guards.

     Falsified by dropping either fetch. */
  assert.match(JS, /'\/v1\/codex\/thought'/);
  assert.match(JS, /'\/v1\/codex\/ocean\/position'/);
});

test('the thought renders its passage and its question, question last', () => {
  /* The question is the last thing read. A card that puts it above the
     passage has un-asked it.

     Falsified by appending the passage after the question. */
  const at = JS.indexOf('function thoughtCard');
  assert.ok(at > 0, 'no thoughtCard');
  const end = JS.indexOf('\n  function ', at + 10);
  const body = JS.slice(at, end > at ? end : at + 1400);
  const passageAt = body.indexOf('passage');
  const questionAt = body.indexOf('question');
  assert.ok(passageAt > 0 && questionAt > 0, 'card renders neither half');
  assert.ok(passageAt < questionAt,
    'the question must be appended after the passage');
});

test('an UNWRITTEN thought says so rather than rendering blank', () => {
  /* A missing thought and an unwritten one look identical to a reader unless
     the card distinguishes them, and only one of them is a day the engine was
     gone -- the rule adeos/codex/thought.py holds one layer down.

     Falsified by rendering the passage regardless of `written`. */
  const at = JS.indexOf('function thoughtCard');
  const end = JS.indexOf('\n  function ', at + 10);
  const body = JS.slice(at, end > at ? end : at + 1400);
  /* The MECHANISM, not the word. `written` appears in prose and in comments;
     what has to exist is the branch -- the question is appended only when the
     day was actually written, and the passage is styled as the question when
     it was not, because a reason is not a passage. A first falsification of
     this guard checked only that the word occurred and stayed green when the
     branch was deleted. */
  assert.match(body, /t\.written\s*\?/, 'the card does not branch on written');
  assert.match(body, /if\s*\(t\.written\)/, 'the question is not gated');
});

test('the frontier line names the position AND the frontier', () => {
  /* "In harbour" hides that the next stratum is empty rather than merely
     deeper. The frontier is the actionable half.

     Falsified by rendering only the station. */
  const at = JS.indexOf('function frontierLine');
  assert.ok(at > 0, 'no frontierLine');
  const end = JS.indexOf('\n  function ', at + 10);
  const body = JS.slice(at, end > at ? end : at + 1200);
  /* Read from the reading, not merely mentioned. Blanking the value left the
     WORD in place and this guard green the first time it was falsified. */
  assert.match(body, /p\.station/, 'the station is not read from the position');
  assert.match(body, /p\.frontier/, 'the frontier is not read from the position');
});

test('the thought stands above EVERY subtab, not inside one', () => {
  /* It is read whether or not a session follows, so it cannot live in a
     single panel. journalPanel paints it before dispatching on the kind.

     Falsified by moving either call inside a case of the switch. */
  const at = JS.indexOf('function journalPanel');
  assert.ok(at > 0, 'no journalPanel');
  const body = JS.slice(at, JS.indexOf('switch (activeKind)', at));
  assert.match(body, /thoughtCard/);
  assert.match(body, /frontierLine/);
});

test('the thought surface is styled', () => {
  assert.match(HTML, /\.thought\s*\{/);
  assert.match(HTML, /\.thought\s+\.tq\s*\{/);
});

test('the pattern page survives a standing block with no by_state', () => {
  /* Every other history panel guards its fetched reads with `||`; this one
     dereferenced `standing.by_state` bare. The endpoint supplies the key
     today, so this is hardening rather than a live bug -- but a shape change
     would throw INSIDE the .then, and a throw there does not render an error,
     it renders NOTHING. The Pattern page would go blank with no way to tell
     why, which is the worst of the available failures.

     Falsified by restoring the bare dereference. */
  assert.doesNotMatch(JS, /standing\.by_state\./,
    'by_state is dereferenced without a fallback');
  assert.match(JS, /\(standing\.by_state \|\| \{\}\)/);
});

/* --------------------------------------------------------------------------
   Ray writes too. Ray, 2026-09-09: "there is no place to write a response".
   -------------------------------------------------------------------------- */

test('the Entries panel does not wipe the standing surfaces', () => {
  /* journalPanel clears the thread ONCE and then appends the thought card and
     the frontier line before dispatching. paintEntries used to clear it again
     on entry -- alone among the five panels, the other four append -- so on
     the Entries subtab both surfaces were destroyed the moment they were
     drawn.

     The guard that claimed they stand above EVERY subtab did not catch this:
     it read journalPanel's own source and never asked what the panel it calls
     does to the thread.

     Falsified by restoring the clear at the top of paintEntries. */
  const at = JS.indexOf('function paintEntries');
  assert.ok(at > 0, 'no paintEntries');
  const end = JS.indexOf('\n  function ', at + 10);
  const body = JS.slice(at, end > at ? end : at + 900);
  assert.doesNotMatch(body, /innerHTML\s*=\s*''/,
    'paintEntries clears the thread and destroys the thought card above it');
});

test('a typed line on the Journal tab with nothing owed WRITES an entry', () => {
  /* It used to fall through to `classify` -- an ordinary ask -- so anything
     typed here became a prompt to the model instead of a journal entry. For a
     raw record that is worse than having nowhere to put it.

     Falsified by removing the branch and letting it fall through. */
  const at = JS.indexOf('function routePlain');
  const end = JS.indexOf('\n  window.__routePlain', at);
  const body = JS.slice(at, end > at ? end : at + 1200);
  assert.match(body, /journal_entry/,
    'nothing owed on the journal tab still falls through to an ask');
});

test('the entry kind is dispatched to the write route', () => {
  /* A route the composer can produce and send() cannot handle would swallow
     the line silently.

     Falsified by dropping the dispatch, or the POST. */
  assert.match(JS, /c\.kind === 'journal_entry'/);
  assert.match(JS, /'\/v1\/codex\/journal', 'POST'/);
});

test('the Entries panel asks for RAY\'s entries as well as Ade\'s', () => {
  /* The GET defaults to author=ade and stays that way, so his are asked for
     by name. Without this his entry is written and never shown.

     Falsified by dropping the author=ray read. */
  assert.match(JS, /author=ray/);
});

test('the footer says the journal can be written in, not only answered', () => {
  /* The hint said "When the Codex asks you something, answer it here", which
     was true and described a journal you cannot write in unprompted.

     Falsified by restoring the answer-only wording alone. */
  /* Scoped to the HINT, not the file. The first version searched the whole
     of chat.js and stayed GREEN when the hint was reverted, because the
     Entries empty-state also says "write here". A guard that any other
     string in the file can satisfy is not guarding the thing it names. */
  const at = JS.indexOf('hint.textContent = "Ad');
  assert.ok(at > 0, 'no journal hint');
  const hint = JS.slice(at, JS.indexOf(';', at));
  assert.match(hint, /write it here/,
    'the journal hint still describes a surface you can only answer');
});

test('the standing reads line up with the fetch order', () => {
  /* renderJournal fetches five routes in one Promise.all and reads them BY
     INDEX. Inserting a fetch without moving the reads makes a panel render
     another route's payload -- silently, with no error, because every one of
     these envelopes is a plain object.

     This guard pins the alignment rather than the comment asking for it.
     Falsified by reordering the Promise.all without moving the reads. */
  const at = JS.indexOf('Promise.all([');
  const block = JS.slice(at, JS.indexOf('}).catch(function (err) {', at));
  const routes = (block.match(/'\/v1\/codex\/[^']*'/g) || []);

  const idx = (needle) => routes.findIndex((r) => r.indexOf(needle) >= 0);
  assert.equal(idx('/v1/codex/journal\''), 0, 'the journal is not first');
  assert.equal(idx('author=ray'), 1, "ray's entries are not second");
  assert.equal(idx('invitation'), 2, 'the invitation is not third');
  assert.equal(idx('thought'), 3, 'the thought is not fourth');
  assert.equal(idx('ocean/position'), 4, 'the position is not fifth');

  assert.match(block, /var r = both\[0\], mine = both\[1\], inv = both\[2\]/);
  assert.match(block, /standingThought = \(both\[3\]/);
  assert.match(block, /standingPosition = \(both\[4\]/);
});

test('the thought offers a way to answer, and only while unanswered', () => {
  /* The thought turns ONE question on the reader; a card that displays it and
     offers no way back is a question asked into a wall. Once answered the
     field is gone and the answer stands in its place -- offering it again
     would invite him to answer twice.

     Falsified by rendering the field unconditionally, or never. */
  const at = JS.indexOf('function thoughtCard');
  const end = JS.indexOf('\n  function ', at + 10);
  const body = JS.slice(at, end > at ? end : at + 2200);
  assert.match(body, /t\.answer/, 'the card never looks at the answer');
  assert.match(body, /createElement\('textarea'\)/,
    'the card offers no field to answer in');
});

test('answering the thought posts to its own route', () => {
  /* Its own record, not a loose journal entry: a stored answer with no
     question attached is an answer to nothing.

     Falsified by posting it as a journal entry instead. */
  assert.match(JS, /'\/v1\/codex\/thought\/answer'/);
});

/* --------------------------------------------------------------------------
   The six Pathwork panels. Ray, 2026-09-09: "build the six panels".

   The five Codex kinds do not disappear -- they FOLD, per the foundation
   document: quest under the gateway, reflection under the analysis, pattern
   and puzzle under the review.
   -------------------------------------------------------------------------- */

test('the subtab bar is the six sections, in order', () => {
  /* THE ORDER IS THE FORM: analysis is what seals vision, and integration is
     what a stratum reads. Falsified by a reorder or an omission. */
  const bar = HTML.slice(HTML.indexOf('id="jtab"'), HTML.indexOf('id="skills"'));
  const kinds = (bar.match(/data-jtab="(\w+)"/g) || [])
    .map((m) => m.replace(/data-jtab="|"/g, ''));
  assert.deepEqual(kinds, ['intent', 'gateway', 'vision', 'analysis',
                           'integration', 'review']);
});

test('the old Codex kinds are gone from the bar, not merely hidden', () => {
  /* A subtab that still exists but is never selected is a panel nobody can
     reach and everybody maintains. Falsified by leaving one in. */
  const bar = HTML.slice(HTML.indexOf('id="jtab"'), HTML.indexOf('id="skills"'));
  for (const gone of ['quest', 'reflection', 'pattern', 'puzzle', 'entries']) {
    assert.doesNotMatch(bar, new RegExp('data-jtab="' + gone + '"'));
  }
});

test('the fold from Codex kind to section is a TABLE', () => {
  /* Like SEALS in pathwork.py: a second fold is a data change, visible in one
     place, rather than another arm on a chain of ifs.

     Falsified by inlining the mapping into the dispatch. */
  const at = JS.indexOf('var FOLD');
  assert.ok(at > 0, 'no FOLD table');
  const table = JS.slice(at, JS.indexOf('}', at) + 1);
  assert.match(table, /quest:\s*'gateway'/);
  assert.match(table, /reflection:\s*'analysis'/);
  assert.match(table, /pattern:\s*'review'/);
  assert.match(table, /puzzle:\s*'review'/);
});

test('every section panel reads and writes its own section route', () => {
  /* One route per section, built from the section name -- a panel that posts
     to another section's path writes the wrong record.

     Falsified by hardcoding one section's path. */
  assert.match(JS, /'\/v1\/codex\/pathwork'/);
  /* Scoped to writeSection. Falsifying this the first time broke the WRITE
     path and stayed green, because amendRow builds the same prefix and
     satisfied a whole-file search. */
  const at = JS.indexOf('function writeSection');
  assert.ok(at > 0, 'no writeSection');
  const body = JS.slice(at, JS.indexOf('function foldedHistory', at));
  assert.match(body,
    /'\/v1\/codex\/pathwork\/' \+ standingSession\.id \+ '\/' \+ section/,
    'the write path does not build its route from the section name');
});

test('the vision panel shows the seal and offers amendment once sealed', () => {
  /* A sealed section that still offers its fields invites a write that will
     be refused, and hides that the record is now closed.

     Falsified by rendering the fields regardless of sealed. */
  /* To questHistoryPanel, not to the next function: sectionPanel delegates,
     and a slice that stopped at the first `function` boundary ended before
     the code this guard is about. */
  const at = JS.indexOf('function sectionPanel');
  assert.ok(at > 0, 'no sectionPanel');
  const body = JS.slice(at, JS.indexOf('function questHistoryPanel', at));
  /* The STRUCTURE, not the word. There are two `if (sealed)` branches -- one
     for the label -- so matching either left this green when the branch that
     actually withholds the fields was broken. What has to hold is that a
     sealed section amends and RETURNS, never reaching the field boxes. */
  assert.match(body, /amendRow\(wrap, section\);\s*threadEl\.appendChild\(wrap\);\s*return;/,
    'a sealed section does not amend-and-return; it would render its fields');
});

test('with no session open the intent panel offers to begin one', () => {
  /* And the frontier it shows comes from the map, not from a field he can
     type into. Falsified by removing the begin path. */
  const at = JS.indexOf('function sectionPanel');
  const body = JS.slice(at, JS.indexOf('function questHistoryPanel', at));
  assert.match(body, /if \(section === 'intent'\) beginCard\(\)/,
    'the intent panel does not offer to begin');
  assert.match(body, /'\/v1\/codex\/pathwork', 'POST'/,
    'nothing opens a session');
});

test('an answered thought can still be answered again', () => {
  /* The store REPLACES an answer -- unlike a Vision Log this is considered
     rather than raw, so it is not sealed. The card hid the field the moment
     an answer existed, which made the UI stricter than the store and left an
     answer unrevisable for ever.

     Found the hard way: a marker written during the migration check occupied
     the slot and there was no way past it.

     Falsified by removing the revise control. */
  const at = JS.indexOf('function thoughtCard');
  const body = JS.slice(at, JS.indexOf('function frontierLine', at));
  assert.match(body, /answer again/,
    'an answered thought offers no way to revise it');
  assert.match(body, /field\.hidden|revise/,
    'the revise control does not reveal the field');
});

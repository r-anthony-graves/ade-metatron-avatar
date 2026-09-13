'use strict';
/* The slash-command popup reads a COMMANDS table, but the commands are
   ACTUALLY implemented as a hand-written `else if (cmd === '...')` chain in
   chat.js. Two lists of the same thing drift, and the drift is invisible: a
   command missing from the table just never autocompletes, and a table entry
   with no branch autocompletes into nothing happening.

   So this guard holds them equal, in both directions, by reading the file.
   It is falsifiable by breaking the thing it guards -- add a branch without a
   table entry (or the reverse) and it fails.

   It also refuses DUPLICATE branches. `plan`, `task`, `steps`, `progress` and
   `review` were each handled twice on 2026-09-05; in an if/else-if chain the
   first match wins, so every second branch was dead code that the popup would
   still have advertised. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');

/* Block and line comments out, so a guard checks CODE and not the prose that
   explains it. Crude on purpose -- it only has to be right about the command
   bodies in this one file, and a real parser here would be a second thing to
   keep correct. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/* Comments AND string literals out, for guards that look for CODE constructs.
   Three guards in this file have now fired on English rather than JavaScript --
   twice on the comment explaining the bug, once on the phrase "no reply from
   the main process." Prose is not code; stop reading it. */
function codeOnly(src) {
  return stripComments(src)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/* Branch openers: `if (cmd === 'name') {` and `} else if (cmd === 'name') {`. */
function branchNames() {
  const out = [];
  const re = /if \(cmd === '([a-z]+)'\) \{/g;
  let m;
  while ((m = re.exec(SRC))) out.push(m[1]);
  return out;
}

/* The COMMANDS literal. Parsed from source rather than required: chat.js is a
   browser IIFE with no exports, and adding module plumbing purely for a test
   would change the shipping file to suit the test. */
function tableEntries() {
  const start = SRC.indexOf('var COMMANDS = [');
  assert.notEqual(start, -1, 'chat.js has no COMMANDS table');
  const end = SRC.indexOf('];', start);
  assert.notEqual(end, -1, 'COMMANDS table is not terminated');
  const block = SRC.slice(start, end);
  const out = [];
  const re = /\{\s*name:\s*'([a-z]+)'[^}]*?stub:\s*(true|false)\s*\}/g;
  let m;
  while ((m = re.exec(block))) out.push({ name: m[1], stub: m[2] === 'true' });
  return out;
}

test('every handled command appears in the COMMANDS table', () => {
  const inChain = new Set(branchNames());
  const inTable = new Set(tableEntries().map((e) => e.name));
  const missing = [...inChain].filter((n) => !inTable.has(n)).sort();
  assert.deepEqual(missing, [], 'handled but not in the table: ' + missing.join(', '));
});

test('every COMMANDS entry is actually handled', () => {
  const inChain = new Set(branchNames());
  const inTable = tableEntries().map((e) => e.name);
  const orphans = inTable.filter((n) => !inChain.has(n)).sort();
  assert.deepEqual(orphans, [], 'in the table but nothing handles it: ' + orphans.join(', '));
});

test('no command is handled twice', () => {
  const seen = new Set();
  const dupes = [];
  for (const n of branchNames()) {
    if (seen.has(n)) dupes.push(n);
    seen.add(n);
  }
  assert.deepEqual([...new Set(dupes)].sort(), [],
    'handled more than once (the second branch is dead code): ' + dupes.join(', '));
});

test('the stub flag matches what the branch actually does', () => {
  /* A table that claims a command works when its body only prints
     "stub - no ... connected" is worse than no table: the popup would
     advertise it as real. */
  const names = branchNames();
  const re = /if \(cmd === '([a-z]+)'\) \{/g;
  const bounds = [];
  let m;
  while ((m = re.exec(SRC))) bounds.push({ name: m[1], at: m.index, end: re.lastIndex });
  /* Two ways a command is a stub, and both are mechanical so this stays
     checkable: it prints "stub - no ... connected", or its own comment calls
     it a stub command. The second case matters -- /market prints
     "Market status: connecting to trader Ade OS..." and connects to nothing,
     which reads as working and is worse than an honest placeholder. */
  const bodyStub = {};
  bounds.forEach((b, i) => {
    if (b.name in bodyStub) return;           /* first match wins, as in the chain */
    const stop = i + 1 < bounds.length ? bounds[i + 1].at : b.end + 1200;
    const body = SRC.slice(b.end, stop);
    bodyStub[b.name] = body.indexOf('stub - no') !== -1
                    || /\/\/[^\n]*stub command/i.test(body);
  });
  const wrong = tableEntries()
    .filter((e) => bodyStub[e.name] !== undefined && bodyStub[e.name] !== e.stub)
    .map((e) => e.name + ' (table says stub=' + e.stub + ')');
  assert.deepEqual(wrong, [], 'stub flag disagrees with the branch: ' + wrong.join(', '));
  assert.ok(names.length > 0, 'no command branches found at all');
});

/* ---------------------------------------------------- shape of the chain */

test('every push() target that looks like the active tab IS activeTab', () => {
  /* `push(activeAb, ...)` appeared 19 times and activeAb is declared nowhere,
     so those branches threw ReferenceError instead of printing. A typo in an
     identifier that only runs when a human types that one command is invisible
     until someone types it. */
  const bad = [];
  const re = /push\(\s*(active[A-Za-z]*)\s*,/g;
  let m;
  while ((m = re.exec(SRC))) {
    if (m[1] !== 'activeTab') bad.push(m[1]);
  }
  assert.deepEqual([...new Set(bad)].sort(), [],
    'push() called with an undeclared tab identifier: ' + [...new Set(bad)].join(', '));
});

test('no command branch compares against more than one word', () => {
  /* cmd is parts[0] -- a single word -- so `cmd === 'persona reload'` can never
     be true. Three such branches shipped and were unreachable; sub-verbs have
     to be read out of `args`. */
  /* Anchored on the branch OPENER, like branchNames() -- an unanchored
     `cmd === '...'` also matches prose, and the first version of this guard
     failed on the comment that explains the bug. */
  const bad = [];
  const re = /if \(cmd === '([a-z]+ [^']*)'\)/g;
  let m;
  while ((m = re.exec(SRC))) bad.push(m[1]);
  assert.deepEqual(bad, [],
    'unreachable multi-word branch (cmd is one word): ' + bad.join(', '));
});

test('/health measures instead of asserting', () => {
  /* It used to answer "Health: all systems nominal - smoke probes passing" --
     a string, not a reading. It said exactly that during the hour chat.js
     could not parse, which is the whole argument against canned status: the
     one time you need it, it is confidently wrong.

     The guard is that the branch actually reaches Ade OS. Falsifiable: swap
     the call back for a literal and this fails. */
  const m = /\} else if \(cmd === 'health'\) \{([\s\S]*?)\n         \} else if/.exec(SRC);
  assert.ok(m, "could not find the /health branch");
  const body = m[1];
  assert.ok(body.indexOf("'/v1/health'") !== -1,
    '/health does not call /v1/health -- it is asserting, not measuring');
  /* Comments stripped first. A guard that reads prose fires on the very
     comment explaining the bug it guards -- this one and the multi-word guard
     both did exactly that before being anchored properly. */
  assert.ok(!/nominal/i.test(stripComments(body)),
    '/health still claims "nominal" from a literal');
});

test('no command branch reaches for node globals', () => {
  /* The chat window runs contextIsolation:true, nodeIntegration:false, so
     `process` does not exist there. /system did `'Electron ' + process.version`
     and threw ReferenceError -- which aborts the keydown handler, so it printed
     nothing AND swallowed the Enter. Anything from main belongs on the bridge. */
  const bad = [];
  const re = /\b(process|require|__dirname|Buffer|ipcRenderer)\s*[.(]/g;
  let m;
  const code = codeOnly(SRC);
  while ((m = re.exec(code))) bad.push(m[1]);
  assert.deepEqual([...new Set(bad)].sort(), [],
    'renderer reaches for a node global that is not there: ' + [...new Set(bad)].join(', '));
});

test('no command answers with silence', () => {
  /* /cancel was `handled = true` and nothing else: it ate the Enter and said
     nothing, which from the outside is indistinguishable from a dead command.
     Every branch has to leave a trace. */
  const re = /if \(cmd === '([a-z]+)'\) \{/g;
  const bounds = [];
  let m;
  while ((m = re.exec(SRC))) bounds.push({ name: m[1], at: m.index, end: re.lastIndex });
  const silent = [];
  bounds.forEach((b, i) => {
    const stop = i + 1 < bounds.length ? bounds[i + 1].at : b.end + 1200;
    const body = stripComments(SRC.slice(b.end, stop));
    /* hideChat() and clearThread() count: the window going away or the
       thread emptying IS the feedback. setTab() used to count too, for
       /journal -- the one command whose tab was not a thread tab, so a
       push after switching would have written into a tab with nothing
       behind it. /journal is gone and no command needs that allowance
       now, so it is off: every remaining branch has to say something. */
    if (body.indexOf('push(') === -1 && body.indexOf('hideChat') === -1
        && body.indexOf('clearThread') === -1) silent.push(b.name);
  });
  assert.deepEqual([...new Set(silent)].sort(), [],
    'command prints nothing and gives no feedback: ' + silent.join(', '));
});

test('send() spins words while Ade works and does not persist them', () => {
  const sendAt = SRC.indexOf('async function send(text');
  const sendEnd = SRC.indexOf('window.__send = send;');
  assert.ok(sendAt > 0 && sendEnd > sendAt, 'could not find send()');
  const body = SRC.slice(sendAt, sendEnd);
  assert.ok(body.indexOf('startSpin(targetTab)') !== -1, 'send() never starts the spinner');
  assert.ok(body.indexOf('stopSpin()') !== -1, 'send() never stops the spinner');
  assert.ok(/var SPIN_WORDS\s*=/.test(SRC), 'no spinner word list');
  assert.ok(SRC.indexOf('Zigzagging') !== -1 && SRC.indexOf('Flibbertigibbeting') !== -1,
    'spinner list is still the short four-word set');
  assert.ok(SRC.indexOf("m.kind !== 'spin'") !== -1,
    'persist() does not strip spinner lines — they would land in threads.json');
});

test('chat sends the thread with /v1/ask', () => {
  const askAt = SRC.indexOf('function askQuestion(');
  const askEnd = SRC.indexOf('async function emptyHelp');
  assert.ok(askAt > 0 && askEnd > askAt, 'could not find askQuestion()');
  const body = SRC.slice(askAt, askEnd);
  assert.ok(body.indexOf('history: threadHistory(threads.chat)') !== -1,
    'askQuestion does not send the Chat thread — each line would be isolated');
  assert.ok(SRC.indexOf('function threadHistory(list)') !== -1);
  assert.ok(SRC.indexOf("m.kind === 'spin'") !== -1
            && SRC.indexOf("m.role === 'system'") !== -1,
    'threadHistory must drop spin/system rows');
});

test('a dead Ade OS is not reported as fetch failed', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/fetch failed\|ECONNREFUSED/.test(main),
    'main.js no longer maps a dropped loopback to a readable error');
  assert.ok(main.indexOf('Ade OS unreachable') !== -1,
    'connection-drop mapping lost its user-facing wording');
});

test('clear-context language does not go to /v1/ask', () => {
  assert.ok(SRC.indexOf('function looksLikeClear') !== -1);
  assert.ok(SRC.indexOf('looksLikeClear(c.text)') !== -1,
    'send() still POSTs a clear-context sentence to /v1/ask');
  assert.ok(SRC.indexOf('looksLikeClear(escPrompt)') !== -1,
    'applyAskResult does not catch a clear escalate');
});

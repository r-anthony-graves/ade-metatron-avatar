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

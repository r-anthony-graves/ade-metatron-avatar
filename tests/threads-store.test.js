'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../threads-store');

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'threads.json');
}

test('loadThreads returns empty tabs when the file is absent', () => {
  const t = store.loadThreads(tmp('absent-'));
  assert.deepEqual(t, { chat: [], shell: [], task: [], archive: [] });
});

test('saveThreads then loadThreads round-trips the three tabs', () => {
  const f = tmp('round-');
  const data = {
    chat: [{ id: 'a', role: 'user', kind: 'text', text: 'hi', meta: {} }],
    shell: [{ id: 'b', role: 'ade', kind: 'shell', text: 'done', meta: { exit: 0 } }],
    task: []
  };
  store.saveThreads(f, data);
  assert.deepEqual(store.loadThreads(f), Object.assign({ archive: [] }, data));
});

test('loadThreads backs up a corrupt file and returns empty tabs', () => {
  const f = tmp('corrupt-');
  fs.writeFileSync(f, '{ not json');
  const t = store.loadThreads(f);
  assert.deepEqual(t, { chat: [], shell: [], task: [], archive: [] });
  assert.strictEqual(fs.existsSync(f + '.bak'), true);
});

test('saveThreads truncates each tab to MAX_MESSAGES', () => {
  const f = tmp('cap-');
  const many = [];
  for (let i = 0; i < store.MAX_MESSAGES + 50; i++) {
    many.push({ id: String(i), role: 'ade', kind: 'text', text: 'm', meta: {} });
  }
  store.saveThreads(f, { chat: many, shell: [], task: [] });
  const loaded = store.loadThreads(f);
  assert.strictEqual(loaded.chat.length, store.MAX_MESSAGES);
  // the NEWEST messages survive, not the oldest
  assert.strictEqual(loaded.chat[0].id, String(50));
  assert.strictEqual(loaded.chat[loaded.chat.length - 1].id, String(store.MAX_MESSAGES + 49));
});

test('loadThreads ignores unknown tabs and keeps only known ones', () => {
  const f = tmp('tabs-');
  fs.writeFileSync(f, JSON.stringify({ chat: [{ id: 'x', role: 'ade', kind: 'text', text: 'y', meta: {} }], stray: [{ n: 1 }], shell: 'not-an-array' }));
  const t = store.loadThreads(f);
  assert.deepEqual(t, {
    chat: [{ id: 'x', role: 'ade', kind: 'text', text: 'y', meta: {} }],
    shell: [], task: [], archive: []
  });
});
/* ---------------------------------------------------------------- archive */
/* /clear and /compact move messages out of a tab instead of destroying them
   (Ray, 2026-09-05: "delete but saved to session memory"). The archive is a
   fourth known key, so it has to survive the same round trip the tabs do --
   loadThreads drops keys it does not know about, which is exactly what would
   have silently eaten this. */

test('saveThreads then loadThreads round-trips the archive', () => {
  const f = tmp('archive-');
  const entry = {
    at: 1788400000000,
    tab: 'chat',
    messages: [{ id: 'a', role: 'user', kind: 'text', text: 'hi', meta: {} }]
  };
  store.saveThreads(f, { chat: [], shell: [], task: [], archive: [entry] });
  const back = store.loadThreads(f);
  assert.deepEqual(back.archive, [entry]);
});

test('threads with no archive key load as an empty archive', () => {
  const f = tmp('noarch-');
  store.saveThreads(f, { chat: [], shell: [], task: [] });
  assert.deepEqual(store.loadThreads(f).archive, []);
});

test('the archive is capped so clearing repeatedly cannot balloon the file', () => {
  const f = tmp('cap-');
  const many = [];
  for (let i = 0; i < store.MAX_ARCHIVE + 12; i++) {
    many.push({ at: i, tab: 'chat', messages: [{ id: String(i) }] });
  }
  store.saveThreads(f, { chat: [], shell: [], task: [], archive: many });
  const back = store.loadThreads(f);
  assert.equal(back.archive.length, store.MAX_ARCHIVE);
  /* the NEWEST entries survive -- an archive that drops what you just cleared
     is worse than none, because the message said it was saved */
  assert.equal(back.archive[back.archive.length - 1].at, store.MAX_ARCHIVE + 11);
});

test('a non-array archive is ignored rather than crashing the load', () => {
  const f = tmp('badarch-');
  fs.writeFileSync(f, JSON.stringify({ chat: [], shell: [], task: [], archive: 'nope' }));
  assert.deepEqual(store.loadThreads(f).archive, []);
});

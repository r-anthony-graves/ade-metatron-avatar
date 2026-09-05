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
  assert.deepEqual(t, { chat: [], shell: [], task: [] });
});

test('saveThreads then loadThreads round-trips the three tabs', () => {
  const f = tmp('round-');
  const data = {
    chat: [{ id: 'a', role: 'user', kind: 'text', text: 'hi', meta: {} }],
    shell: [{ id: 'b', role: 'ade', kind: 'shell', text: 'done', meta: { exit: 0 } }],
    task: []
  };
  store.saveThreads(f, data);
  assert.deepEqual(store.loadThreads(f), data);
});

test('loadThreads backs up a corrupt file and returns empty tabs', () => {
  const f = tmp('corrupt-');
  fs.writeFileSync(f, '{ not json');
  const t = store.loadThreads(f);
  assert.deepEqual(t, { chat: [], shell: [], task: [] });
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
    shell: [], task: []
  });
});
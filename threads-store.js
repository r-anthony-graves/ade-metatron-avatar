/* Persistence for the chat window's three threads (chat, shell, task).
 *
 * A pure module: no Electron imports, so it can be unit-tested with plain
 * `node --test`. The renderer never touches this file -- it sends whole
 * thread objects over IPC and main.js calls saveThreads() (debounced there).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_MESSAGES = 4000;   /* hard safety floor per tab (spec: uncapped in
                                normal use) -- only keeps a runaway thread from
                                ballooning the file forever */
const TABS = ['chat', 'shell', 'task'];

/* /clear and /compact move messages OUT of a tab rather than destroying them:
   Ray, 2026-09-05, "delete but saved to session memory". Each entry is
   { at, tab, messages }. Capped because clearing is cheap and repeated: an
   uncapped archive would grow this file without limit, which is the failure
   MAX_MESSAGES already guards for the tabs themselves. The cap keeps the
   NEWEST entries -- dropping what you just cleared would make the "saved to
   session memory" message a lie. */
const MAX_ARCHIVE = 20;

function defaultThreads() {
  return { chat: [], shell: [], task: [], archive: [] };
}

function loadThreads(file) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return defaultThreads(); }
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    /* Never destroy data silently; rename it aside so the next run can
       recover whatever it was. */
    try { fs.renameSync(file, file + '.bak'); } catch (e2) {}
    return defaultThreads();
  }
  const out = defaultThreads();
  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    if (Array.isArray(data && data[tab])) out[tab] = data[tab].slice(-MAX_MESSAGES);
  }
  if (Array.isArray(data && data.archive)) out.archive = data.archive.slice(-MAX_ARCHIVE);
  return out;
}

function saveThreads(file, data) {
  const out = defaultThreads();
  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    if (Array.isArray(data && data[tab])) out[tab] = data[tab].slice(-MAX_MESSAGES);
  }
  if (Array.isArray(data && data.archive)) out.archive = data.archive.slice(-MAX_ARCHIVE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
}

module.exports = { loadThreads, saveThreads, defaultThreads, MAX_MESSAGES, MAX_ARCHIVE };
/* Avatar-local files tree. Lives next to threads.json under userData, not
 * in Ade OS's workspace. A pure module so node --test can create the layout
 * without booting Electron.
 *
 *   files/voice      TTS WAVs
 *   files/uploads    local copies of drops
 *   files/exports    things the avatar writes out
 *   files/scratch    throwaways
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILES_SUBDIRS = ['voice', 'uploads', 'exports', 'scratch'];

function filesRoot(userData) {
  return path.join(String(userData || ''), 'files');
}

function ensureFilesLayout(userData) {
  const root = filesRoot(userData);
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < FILES_SUBDIRS.length; i++) {
    fs.mkdirSync(path.join(root, FILES_SUBDIRS[i]), { recursive: true });
  }
  return root;
}

module.exports = { filesRoot, ensureFilesLayout, FILES_SUBDIRS };

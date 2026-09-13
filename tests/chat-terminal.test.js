'use strict';
/* The chat's bare-line detector (docs/superpowers/plans/
   2026-09-13-chat-terminal-commands.md Task 2). Task 4 appends the
   chat.js/main.js/preload.js/chat.html source guards to this same file.

   The detector is conservative to chat: only lines that clearly look like
   PowerShell run; everything else stays Ade's. `get-process` runs, `hi; how
   are you` does not. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../terminal-detect.js');

const SHOULD_RUN = [
  'get-process',
  'get-process -Name powershell',
  'Set-Location D:\\temp',
  'ls',
  'ls -la',
  'dir',
  'cd C:\\Users',
  'pwd',
  'cls',
  'git status',
  "git commit -m 'release'",
  'node --version',
  'python -m http.server 8000',
  'npm run build',
  '.\\scripts\\adeos-run.ps1',
  '..',
  '.',
  'D:\\tradinglocal\\live.py',
  'whoami',
  'ipconfig /all',
  'C:\\Program Files\\Git\\bin\\git.exe --version',
  '$x = 42',
  'dir | clip',
  'ping 1.1.1.1 > nul',
  '& cmd /c dir',
  '-List',
  'get-childitem C:\\Users',
  '.\\activate.ps1'
];

const SHOULD_CHAT = [
  'hi how are you',
  'hi; how are you',
  'hello, world',
  'hello',
  'what is the weather',
  'why does the build fail',
  'please fix the bug',
  'set a reminder for tomorrow',
  'the cat is on the roof',
  'list all files in the project',
  'start the build',
  'get the latest commit message',
  'new feature for coding agent',
  'remove everything from the disk',
  'i think we should deploy',
  'echo hello',
  'clear the screen',
  'man git',
  'thanks for all the help',
  'gitlab is down',
  'where are my keys',
  'show dirs in the project',
  "copy that",
  'move on',
  'select the option',
  'can you list files'
];

test('lines that clearly look like commands are commands', () => {
  for (const line of SHOULD_RUN) {
    const r = detect(line);
    assert.equal(r.command, true, 'should RUN: ' + JSON.stringify(line) + ' -> ' + r.reason);
  }
});

test('everything else stays Ade\'s', () => {
  for (const line of SHOULD_CHAT) {
    const r = detect(line);
    assert.equal(r.command, false, 'should CHAT: ' + JSON.stringify(line) + ' -> ' + r.reason);
  }
});

test('a command line after a conversational opener is chat (stop wins)', () => {
  assert.equal(detect('hi; how are you').command, false);
  assert.equal(detect('please run git status').command, false);
});

test('detect() is case-insensitive on the first token', () => {
  assert.equal(detect('Get-Process').command, true);
  assert.equal(detect('GIT STATUS').command, true);
  assert.equal(detect('LS').command, true);
  assert.equal(detect('WHOAMI').command, true);
});

test('empty and whitespace-only lines are not commands', () => {
  assert.equal(detect('').command, false);
  assert.equal(detect('   ').command, false);
  assert.equal(detect(null).command, false);
  assert.equal(detect(undefined).command, false);
});
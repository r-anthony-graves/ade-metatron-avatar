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

/* ------------------------------------------------- bridge streaming */
const fs = require('fs');
const path = require('path');

/* Slice of main.js covering ONLY the adeStream function body (from its
   declaration to the next ipcMain.handle registration). Whole-file scans
   are not falsifiable for this handler: handleAdeCall carries the same
   /v1/ refusal line and ade() carries the AbortController/timeout
   machinery, so both the refusal guard and the no-timeout guard must be
   scoped to the stream handler itself. */
function adeStreamBody(main) {
  const start = main.indexOf('async function adeStream');
  assert.ok(start !== -1, 'main.js has no adeStream function -- the stream bridge is gone');
  const end = main.indexOf('ipcMain.handle(', start);
  assert.ok(end !== -1, 'adeStream body runs into no ipcMain.handle(...) -- slice anchor gone');
  return main.slice(start, end);
}

test('main.js forwards terminal stream chunks to the renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.indexOf("ipcMain.handle('ade:stream'") !== -1,
    'main.js has no ade:stream handler -- the renderer cannot reach the stream');
  assert.ok(main.indexOf("'ade:stream:chunk'") !== -1,
    'main.js does not forward body chunks as ade:stream:chunk');
  assert.ok(/pathname\.startsWith\('\/v1\/'\)/.test(adeStreamBody(main)),
    'adeStream lost the /v1/* refusal -- a renderer-supplied pathname would POST un-gated');
});

test('adeStream body has no timeout: long terminal commands must never die silently', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const stream = adeStreamBody(main);
  assert.ok(!/AbortController/.test(stream),
    'adeStream gained AbortController -- the no-timeout invariant is broken');
  assert.ok(!/AbortSignal/.test(stream),
    'adeStream gained AbortSignal -- the no-timeout invariant is broken');
  assert.ok(!/setTimeout/.test(stream),
    'adeStream gained setTimeout -- the no-timeout invariant is broken');
});

test('preload exposes the streaming surface to the renderer', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(preload.indexOf('stream: (pathname, body)') !== -1,
    'preload has no stream() bridge method');
  assert.ok(preload.indexOf("onStreamChunk: (fn)") !== -1,
    'preload has no onStreamChunk() bridge method');
});

/* ------------------------------------------------- chat.js source guards */
/* A guard must be falsified by breaking the thing it guards. These read the
   shipping file (comments stripped, prose never read) and fail if the
   behavior they pin disappears from the code. */
const SRC_CHAT = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');
function sc(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
const code = sc(SRC_CHAT);

test('routePlain consults the detector for unprefixed lines', () => {
  assert.ok(code.indexOf('DetectCommandLine(v).command') !== -1,
    'routePlain no longer asks the detector -- bare commands would all stay chat');
  assert.ok(code.indexOf('forceChat') !== -1,
    'routePlain has no forceChat escape -- voice could auto-run a bare command');
});

test('inline means the Chat thread, not the Shell tab', () => {
  assert.ok(code.indexOf("c.inline ? 'chat' : 'shell'") !== -1,
    'an inline command no longer targets the chat thread');
  assert.ok(code.indexOf("'$ ' + c.text") !== -1
    || code.indexOf("'$ '") !== -1,
    'inline user lines no longer render as $ command');
  assert.ok(code.indexOf("B.stream('/v1/terminal/run'") !== -1,
    'send() does not reach the streaming endpoint for inline commands');
});

test('busy never swallows a typed line', () => {
  assert.ok(code.indexOf('if (!raw.trim() || busy || !B) return;') === -1,
    'the busy swallow is back: a line typed mid-turn vanishes');
  assert.ok(code.indexOf('if (busy) {') !== -1,
    'the busy-staged branch is gone');
  assert.ok(code.indexOf('input.value = raw') !== -1,
    'the typed line is not restaged on a busy turn');
});

test('voice routing is unchanged: bare spoken lines never auto-run', () => {
  assert.ok(code.indexOf('send(typed, true)') !== -1,
    'the voice ground-ask line no longer forces chat -- a spoken "git status" would run');
});

test('a failed inline run never swallows the line: error bubble and restage', () => {
  const inlineAt = code.indexOf('function runInline(cmd)');
  assert.ok(inlineAt !== -1,
    'runInline is gone from chat.js -- inline commands would stop working');
  const inlineEnd = code.indexOf('function applyAskResult(result)', inlineAt);
  assert.ok(inlineEnd > inlineAt,
    'runInline body lost its closing anchor -- slice drifted');
  const inlineBody = code.slice(inlineAt, inlineEnd);
  assert.ok(inlineBody.indexOf("push('chat', 'ade', 'error',") !== -1,
    'a pre-frame runInline failure pushes no Ade error bubble -- a twin-down line is silently eaten');
  assert.ok(inlineBody.indexOf('Call failed: ') !== -1,
    'the inline error bubble no longer names the bridge cause');
  const sendAt = code.indexOf('async function send(text');
  const sendEnd = code.indexOf('window.__send = send;');
  assert.ok(sendAt > 0 && sendEnd > sendAt, 'could not find send()');
  const sendBody = code.slice(sendAt, sendEnd);
  assert.ok(sendBody.indexOf('var ok = await runInline(c.text)') !== -1,
    'send() discards runInline\'s result -- a failed inline line is never restaged');
  assert.ok(sendBody.indexOf('!ok.ok') !== -1,
    'send() does not check runInline\'s failure -- a failed inline line is never restaged');
});
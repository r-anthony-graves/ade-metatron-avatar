/* The only bridge between the glyph and the machine.
 *
 * Deliberately narrow: the renderer cannot reach Node, cannot spawn anything,
 * and cannot call an arbitrary URL. It can ask the main process to talk to the
 * local Ade OS, and that is all -- so every effect on the computer still goes
 * through Ade's permission gate and audit log.
 */
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('adeBridge', {
  /* pathname must be /v1/* on 127.0.0.1:8300; main enforces it again */
  call: (pathname, method, body) => ipcRenderer.invoke('ade:call', pathname, method, body),
  state: () => ipcRenderer.invoke('ade:state'),
  config: () => ipcRenderer.invoke('cfg:get'),
  speakEnabled: () => ipcRenderer.invoke('cfg:speak'),
  speak: (text) => ipcRenderer.invoke('ade:speak', text),

  /* ---- chat window surface (both windows may call these) ---- */
  openChat: (tab) => ipcRenderer.send('chat:open', tab),
  hideChat: () => ipcRenderer.send('chat:hide'),
  threadsLoad: () => ipcRenderer.invoke('threads:load'),
  threadsSave: (data) => ipcRenderer.send('threads:save', data),
  micToggle: () => ipcRenderer.send('mic:toggle'),
  micStatus: () => ipcRenderer.invoke('mic:status'),
  saySpeech: (ev) => ipcRenderer.send('chat:speech', ev),
  onChatFocus: (fn) => ipcRenderer.on('chat:focus', (_e, tab) => fn(tab)),
  onSpeech: (fn) => ipcRenderer.on('chat:speech', (_e, ev) => fn(ev)),
  onMicState: (fn) => ipcRenderer.on('mic:state', (_e, live) => fn(!!live)),

  /* File and folder upload. The renderer never reads a file and never sends
     one: the page's CSP is `default-src 'none'`, so it cannot reach the
     network at all, and Electron 32 removed `File.path`, so it cannot even
     learn what was dropped. `webUtils.getPathForFile` runs HERE, in the
     preload, and main does the walking and the POSTing.
     What crosses this boundary is a list of strings, one way. */
  dropPaths: (files) => Array.from(files || []).map((f) => {
    try { return webUtils.getPathForFile(f); } catch (e) { return ''; }
  }).filter(Boolean),
  pick: (wantFolder) => ipcRenderer.invoke('ade:pick', !!wantFolder),
  upload: (paths, overwrite) => ipcRenderer.invoke('ade:upload', paths, !!overwrite),

  /* ---- glyph-window events (unchanged) ---- */
  onState: (fn) => ipcRenderer.on('ade:state', (_e, s) => fn(s)),
  onToggleBar: (fn) => ipcRenderer.on('ui:toggleBar', () => fn()),
  onArm: (fn) => ipcRenderer.on('ui:arm', () => fn()),
  onSize: (fn) => ipcRenderer.on('ui:size', (_e, px) => fn(px)),
  onNote: (fn) => ipcRenderer.on('ui:note', (_e, msg) => fn(msg)),
  onBacking: (fn) => ipcRenderer.on('ui:backing', (_e, on) => fn(on)),
  onSpeak: (fn) => ipcRenderer.on('ui:speak', (_e, t) => fn(t)),
  onHush: (fn) => ipcRenderer.on('ui:hush', () => fn()),
  micState: (live) => ipcRenderer.send('mic:state', !!live),
  onMicToggle: (fn) => ipcRenderer.on('ui:micToggle', () => fn()),
  onPttDown: (fn) => ipcRenderer.on('ui:pttDown', () => fn()),
  onPttUp: (fn) => ipcRenderer.on('ui:pttUp', () => fn()),

  shortcuts: () => ipcRenderer.invoke('app:shortcuts'),
  hit: (on) => ipcRenderer.send('win:hit', !!on),
  bar: (open) => ipcRenderer.send('win:bar', !!open),
  dragStart: () => ipcRenderer.invoke('win:dragStart'),
  dragMove: () => ipcRenderer.send('win:dragMove'),
  dragEnd: () => ipcRenderer.send('win:dragEnd'),

  menu: () => ipcRenderer.send('app:menu'),
  quit: () => ipcRenderer.send('app:quit'),
  copy: (text) => ipcRenderer.send('app:copy', text)
});

/* The only bridge between the glyph and the machine.
 *
 * Deliberately narrow: the renderer cannot reach Node, cannot spawn anything,
 * and cannot call an arbitrary URL. It can ask the main process to talk to the
 * local Ade OS, and that is all -- so every effect on the computer still goes
 * through Ade's permission gate and audit log.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeBridge', {
  /* pathname must be /v1/* on 127.0.0.1:8300; main enforces it again */
  call: (pathname, method, body) => ipcRenderer.invoke('ade:call', pathname, method, body),
  state: () => ipcRenderer.invoke('ade:state'),
  config: () => ipcRenderer.invoke('cfg:get'),
  speakEnabled: () => ipcRenderer.invoke('cfg:speak'),
  speak: (text) => ipcRenderer.invoke('ade:speak', text),

  onState: (fn) => ipcRenderer.on('ade:state', (_e, s) => fn(s)),
  onToggleBar: (fn) => ipcRenderer.on('ui:toggleBar', () => fn()),
  onArm: (fn) => ipcRenderer.on('ui:arm', () => fn()),
  onSize: (fn) => ipcRenderer.on('ui:size', (_e, px) => fn(px)),
  onNote: (fn) => ipcRenderer.on('ui:note', (_e, msg) => fn(msg)),
  onBacking: (fn) => ipcRenderer.on('ui:backing', (_e, on) => fn(on)),
  onSpeak: (fn) => ipcRenderer.on('ui:speak', (_e, t) => fn(t)),
  onHush: (fn) => ipcRenderer.on('ui:hush', () => fn()),
  onPttDown: (fn) => ipcRenderer.on('ui:pttDown', () => fn()),
  onPttUp: (fn) => ipcRenderer.on('ui:pttUp', () => fn()),

  /* whether the cursor is over painted pixels -- everything else is handed
     back to the window underneath, see applyHit() in main.js */
  /* which hotkeys actually bound -- the hint line has to name the real one,
     not a second hardcoded string that goes stale on the next fallback */
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

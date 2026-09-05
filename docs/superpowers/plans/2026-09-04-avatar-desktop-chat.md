# Desktop Chat Window (Camera movement to a real window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the avatar's command surface out of the under-glyph bar and into a normal desktop window with three persistent threads (Chat / Shell / Task), launched by the always-on-top glyph.

**Architecture:** One Electron process, two windows. The transparent glyph window (`win`) keeps the canvas, the microphone/PTT engine, and the click-through hit logic, and becomes a launcher. A new framed window (`chatWin`) hosts `chat.html`/`chat.js`: tabbed threads persisted by a small main-process store (`threads-store.js`), with approvals, skills, upload, and the mic toggle mirrored in. Speech from the glyph renderer crosses to the chat window through main as `chat:speech` events; classification, dispatch, and the task-dispatch counter live in `chat.js` and nowhere else.

**Tech Stack:** Electron (already vendored in `node_modules/electron`), plain ES5-style renderer JS (matches `ui.js`/`glyph.js` idiom — `'use strict'; (function(){ ... })()`), CommonJS in main, `node:test` for the pure module, and the existing `--smoke` self-test as the UI harness.

## Global Constraints

- **No new dependencies.** No npm installs. Only the already-vendored Electron; system Node v24 (`C:\Program Files\nodejs\node.exe`) is used only for the pure-module unit test.
- **Reviewer-facing smoke harness:** `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000` from `C:\Users\ray_g\ade-ai\adeos\avatar`. It exits with a JSON summary and `app.exit(0)`; a task is only green when the summary's `ok` fields it owns are `true` and the run prints the full SMOKE line without a terminal `rendererErrors` other than empty.
- **Renderer CSP stays `default-src 'none'`** in BOTH `avatar.html` and `chat.html`. Renderers never touch the filesystem or the network except through `preload.js` → IPC → `main.js`.
- **The single classifier lives in `chat.js`.** `classify()`, `dispatchTask()`, `applyAskResult()`, `runVoice()` and their `__`-exports move with it; the glyph renderer keeps only the mic/PTT/wake machinery and relays speech onward.
- **A shell command is never dispatched by recognition or by an escalation** — it always waits on a human Enter in the Shell tab (Shell voice stages `! …` into the input). Escalations stage into the Task tab input and never call `dispatchTask()`. The only recognised-phrase task dispatch that survives is the deliberately configured `VOICE_ACTIONS` `'run the tests'`, exactly as it behaves today; the smoke's staged-speech invariant (`pttSmoke.noDispatch`) guards everything in the staging path anyway.
- `/v1/terminal` is ungated; the Shell tab is permanently labelled "NOT gated by Permission.check()".
- Git identity is already set in this repo (`Ade <ade@ade-ai.local>`); do not change it.
- Keep the existing style: no new autoputputs, no emojis in code or commit messages, `innerHTML` only for this project's own static hint markup, `textContent` for everything untrusted.
- Message palette tokens (from `avatar.html`): `--red:#8e1b2a; --vermilion:#d9451f; --orange:#ef7a1e; --amber:#f5a623; --yellow:#f7ce3e; --steel:#6e7681; --ink:#262a31; --panel:rgba(228,232,238,.92); --line:rgba(110,118,129,.34)`.

## File Map

| File | Role after this plan |
|---|---|
| `threads-store.js` (new) | Pure load/save of the three threads; corrupt-file `.bak`; hard message cap |
| `chat.html` (new) | The tabbed window; same CSP + palette as the avatar |
| `chat.js` (new) | Tabs, threads render, classify/send, approvals, skills, upload, mic mirror, voice handling |
| `avatar.html` | `#bar` block deleted (Task 6) |
| `ui.js` | Shrinks to drag/click/hit, mic+PTT+wake+speak, speech relay (Task 5/6) |
| `preload.js` | Adds `chat:*`, `threads:*`, `mic:toggle|status`, `saySpeech`, `onChatFocus`/`onSpeech`/`onMicState` (Task 2), drops `onToggleBar`/`bar` (Task 7) |
| `main.js` | Creates `chatWin` + open/hide/bounds, threads + mic IPC, approval/voice relay, hotkey `chat`, tray wording, smoke rework |
| `ptt.js`, `glyph.js` | Unchanged |
| `run-avatar.ps1` | Unchanged |
| `README.md` | Bar sections rewritten for the window (Task 7) |
| `tests/threads-store.test.js` (new) | `node:test` unit tests for Task 1 |

Task dependency order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Each task keeps `--smoke` green before commit.

---

### Task 2: Chat window skeleton (window + bridge + IPC + threads)

**Files:**
- Modify: `preload.js`
- Modify: `main.js` (top requires, config defaults, `chatWin` creation + IPC, tray item, smoke probe)
- Create: `chat.html`
- Create: `chat.js`
- Test: `--smoke` (`chatProbe` block in `startSmokeRun`)

**Interfaces:**
- Consumes: `loadThreads`/`saveThreads` from Task 1.
- Produces (bridges, both windows via `window.adeBridge`): `openChat(tab)` → send `'chat:open'`; `hideChat()` → send `'chat:hide'`; `threadsLoad()` → invoke `'threads:load'` returns thread object; `threadsSave(data)` → send `'threads:save'`; `micStatus()` → invoke `'mic:status'` returns boolean; `micToggle()` → send `'mic:toggle'`; `saySpeech(ev)` → send `'chat:speech'` (used from Task 5); `onChatFocus(fn)` ← `'chat:focus'`; `onSpeech(fn)` ← `'chat:speech'`; `onMicState(fn)` ← `'mic:state'`.
- Produces (main): `chatWin` (hidden, framed, 900x620, `title:'Ade'`), `threadsPath()` (temp dir under `--smoke`), debounced `threads:save`, `ade:state` broadcast to both windows, `mic:state` broadcast to `chatWin`.

- [ ] **Step 1: Write the failing smoke probe**

In `main.js` `startSmokeRun()`, insert this block immediately BEFORE the `console.log('SMOKE ' + JSON.stringify({` line:

```js
    /* The chat window exists, is a real framed window, stays hidden until
       opened, draws the three tab names, and persists threads through the
       bridge. The temp threads path keeps the smoke run off Ray's real file. */
    let chatProbe = {};
    try {
      chatProbe.exists = !!(chatWin && !chatWin.isDestroyed());
      if (chatWin) {
        chatProbe.hiddenAtLaunch = !chatWin.isVisible();
        chatProbe.resizable = chatWin.isResizable();
        chatProbe.inTaskbar = !chatWin.isSkipTaskbar();
        chatProbe.title = chatWin.getTitle();
        chatProbe.tabs = JSON.parse(await chatWin.webContents.executeJavaScript(
          'JSON.stringify([].map.call(document.querySelectorAll("#tabs .tab"), function(t){ return t.getAttribute("data-tab"); }))'
        ));
        await new Promise((r) => setTimeout(r, 300));
        chatProbe.loadedThreads = await chatWin.webContents.executeJavaScript(
          'window.__threadsLoaded ? window.__threads().chat.length : -1'
        );
        await chatWin.webContents.executeJavaScript(
          'window.adeBridge.threadsSave({chat:[{id:"smoke",role:"user",kind:"text",text:"t",meta:{}}],shell:[],task:[]}),0'
        );
        await new Promise((r) => setTimeout(r, 900));   /* main's 400ms write debounce */
        chatProbe.bridgeRoundTrip = await chatWin.webContents.executeJavaScript(
          '(async function(){ var t = await window.adeBridge.threadsLoad(); return t && t.chat && t.chat[0] ? t.chat[0].id : null; })()'
        );
      }
      chatProbe.ok = chatProbe.exists === true
        && chatProbe.hiddenAtLaunch === true
        && chatProbe.resizable === true
        && chatProbe.inTaskbar === true
        && chatProbe.title === 'Ade'
        && JSON.stringify(chatProbe.tabs) === JSON.stringify(['chat', 'shell', 'task'])
        && chatProbe.loadedThreads === 0
        && chatProbe.bridgeRoundTrip === 'smoke';
    } catch (e) { chatProbe = { error: String((e && e.message) || e) }; }
```

Now add `chatProbe,` to the SMOKE summary object (insert it right after the `visible: win.isVisible(),` line in the existing `console.log('SMOKE ' + JSON.stringify({ ... }))`).

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `chatProbe` shows `{error: ... }`, `exists: false`, or the probe asserts are false, because `chatWin` does not exist yet.

- [ ] **Step 3: Extend `preload.js`**

`preload.js` already exists; add the chat/threads/mic surface to the exposed object. Keep every existing method unchanged. The full new `contextBridge.exposeInMainWorld('adeBridge', { ... })` body:

```js
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
```

(The `bar`/`onToggleBar` entries are removed in Task 6/7 — keep them for now.)

- [ ] **Step 4: Extend `main.js`**

**4a.** Add the store require after the `os` require:

```js
const { loadThreads, saveThreads } = require('./threads-store');
```

**4b.** Add the chat window to the module declarations:

```js
let win = null, tray = null, timer = null, dragAnchor = null;
let chatWin = null;                 /* the desktop conversation window */
let overPaint = false, barOpen = false, lastIgnore = null;
```

**4c.** Add chat bounds to the config defaults (with values that stay off-screen-safe):

```js
let cfg = { x: null, y: null, size: 380, clickThrough: false, speak: false, opacity: 1, backing: true, mic: true,
            chatX: null, chatY: null, chatW: 900, chatH: 620 };
```

**4d.** After `saveCfg()` add the threads path + debounced writer + flush:

```js
let smokeThreadsDir = null;
function threadsPath() {
  if (!SMOKE) return path.join(app.getPath('userData'), 'threads.json');
  if (!smokeThreadsDir) smokeThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-threads-smoke-'));
  return path.join(smokeThreadsDir, 'threads.json');
}
let threadsTimer = 0, lastThreads = null;
function queueThreadsSave(data) {
  lastThreads = data;
  if (threadsTimer) clearTimeout(threadsTimer);
  threadsTimer = setTimeout(() => {
    threadsTimer = 0;
    try { saveThreads(threadsPath(), lastThreads); } catch (e) {}
  }, 400);
}
function flushThreads() {
  if (threadsTimer) { clearTimeout(threadsTimer); threadsTimer = 0; }
  if (lastThreads) { try { saveThreads(threadsPath(), lastThreads); } catch (e) {} lastThreads = null; }
}
```

**4e.** After `createWindow()` add the chat window. Insert this next to the existing window code (right after the `createWindow` function closes):

```js
/* The conversation window. A REAL window: framed, resizable, taskbar-listed,
   not always-on-top -- the "desktop" the request asked for, distinct from the
   transparent click-through glyph. Created hidden; the glyph, the hotkey and
   the voice path open it. Closing it hides it: the orb keeps the app alive. */
function createChatWindow() {
  chatWin = new BrowserWindow({
    width: cfg.chatW || 900, height: cfg.chatH || 620,
    ...(cfg.chatX == null ? {} : { x: cfg.chatX, y: cfg.chatY }),
    frame: true, title: 'Ade', show: false,
    resizable: true, minimizable: true, maximizable: true, fullscreenable: true,
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  chatWin.loadFile('chat.html');
  const saveBounds = () => {
    if (!chatWin || chatWin.isDestroyed()) return;
    const [x, y] = chatWin.getPosition();
    const [w, h] = chatWin.getSize();
    cfg.chatX = x; cfg.chatY = y; cfg.chatW = w; cfg.chatH = h;
    saveCfg();
  };
  chatWin.on('moved', saveBounds);
  chatWin.on('resize', saveBounds);
  chatWin.on('close', (e) => {                    /* X hides; the app lives */
    e.preventDefault();
    if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
  });
  chatWin.on('closed', () => { chatWin = null; });
}

/* Open/focus the chat window; `tab` optionally pre-selects a thread. */
function openChat(tab) {
  if (!chatWin || chatWin.isDestroyed()) return;
  if (cfg.chatX != null) {
    const b = chatWin.getBounds();
    const fitted = clampToScreen(b.x, b.y, b.width, b.height);
    if (fitted.x !== b.x || fitted.y !== b.y) chatWin.setPosition(fitted.x, fitted.y);
  }
  chatWin.show();
  chatWin.focus();
  if (tab && chatWin.webContents) chatWin.webContents.send('chat:focus', tab);
}
```

**4f.** Broadcast state to both windows — in `pollAde()`, replace the single-send line:

```js
  if (win && !win.isDestroyed()) win.webContents.send('ade:state', state);
```
with
```js
  if (win && !win.isDestroyed()) win.webContents.send('ade:state', state);
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ade:state', state);
```

**4g.** IPC handlers. Add, next to the existing `ipcMain.on('mic:state', ...)` handler:

```js
ipcMain.handle('threads:load', () => {
  try { return loadThreads(threadsPath()); } catch (e) { return { chat: [], shell: [], task: [] }; }
});
ipcMain.on('threads:save', (_e, data) => queueThreadsSave(data));
ipcMain.on('chat:open', (_e, tab) => openChat(tab));
ipcMain.on('chat:hide', () => { if (chatWin && !chatWin.isDestroyed()) chatWin.hide(); });
ipcMain.on('mic:toggle', () => win && win.webContents.send('ui:micToggle'));
ipcMain.handle('mic:status', () => !!micLive);
```

And in the EXISTING `ipcMain.on('mic:state', ...)` handler, append the chat-window broadcast before the closing brace:

```js
ipcMain.on('mic:state', (_e, live) => {
  micLive = !!live;
  if (cfg.mic !== micLive) { cfg.mic = micLive; saveCfg(); }
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('mic:state', micLive);
});
```

**4h.** Tray item — in `buildMenu()`, insert before the `'Command bar'` item:

```js
    { label: 'Chat window', click: () => openChat() },
```

**4i.** Lifecycle — in `app.whenReady().then(...)`, add `createChatWindow();` right after `createTray();`. In the `second-instance` handler, replace `if (win) { win.show(); win.focus(); }` with `openChat();`. In the `will-quit` handler, add `flushThreads();` after `clearInterval(timer)`.

- [ ] **Step 5: Create `chat.html`**

Create `chat.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;">
<title>Ade</title>
<style>
  :root {
    --red:#8e1b2a; --vermilion:#d9451f; --orange:#ef7a1e;
    --amber:#f5a623; --yellow:#f7ce3e;
    --steel:#6e7681; --ink:#262a31;
    --panel:#f3f4f6; --line:#d4d7dd;
  }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; }
  body { display:flex; flex-direction:column; background:var(--panel); color:var(--ink);
         font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
         user-select:none; cursor:default; }
  header { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:8px 12px;
           background:#fff; border-bottom:1px solid var(--line); }
  #orb-dot { width:12px; height:12px; border-radius:50%; background:var(--steel);
             transition:background .3s ease; }
  #orb-dot.online { background:#7a8c38; }
  #orb-dot.busy { background:var(--orange); }
  #orb-dot.pending { background:var(--vermilion); }
  h1 { flex:0 0 auto; margin:0; font-size:13px; font-weight:600; letter-spacing:.04em; }
  #brain { flex:1 1 auto; text-align:right; font:400 10.5px/1 "Consolas","Segoe UI",monospace;
           color:var(--steel); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #tabs { flex:0 0 auto; display:flex; gap:2px; padding:0 12px; background:#fff;
          border-bottom:1px solid var(--line); }
  .tab { font:600 11px/1 "Segoe UI",sans-serif; letter-spacing:.07em; text-transform:uppercase;
         padding:9px 14px; color:var(--steel); cursor:pointer; border:none; background:none;
         border-bottom:2px solid transparent; }
  .tab:hover { color:var(--ink); }
  .tab.on { color:var(--ink); border-bottom-color:var(--orange); }
  #skills { flex:0 0 auto; background:#fff; border-bottom:1px solid var(--line); display:none; }
  #skills.show { display:flex; flex-wrap:wrap; gap:4px; padding:6px 12px; }
  #skills span { font-size:10px; padding:1px 8px; border-radius:9px;
                 background:rgba(88,166,255,.12); color:#2f6ab8;
                 border:1px solid rgba(88,166,255,.3); }
  main { flex:1 1 auto; overflow-y:auto; padding:12px; }
  .msg { clear:both; }
  .bubble { display:inline-block; max-width:78%; border-radius:8px; padding:6px 9px;
            font:400 12.5px/1.45 "Segoe UI",system-ui,sans-serif;
            user-select:text; cursor:text; white-space:pre-wrap; word-break:break-word; }
  .msg.user .bubble { background:var(--yellow); color:#4a3b04; float:right; }
  .msg.ade  .bubble { background:#fff; border:1px solid var(--line); color:#333840; }
  .msg.err  .bubble { background:#fbeaec; border:1px solid #e2a9b0; color:var(--red); }
  .msg.shell .bubble, .msg.res .bubble { background:#262a31; color:#cfd6e0; width:100%;
    font-family:"Cascadia Mono","Consolas",ui-monospace,monospace; font-size:11.5px; }
  .msg.sys { font-size:10.5px; color:var(--steel); margin:6px 2px; text-align:center; }
  .meta { font-size:9.5px; color:var(--steel); margin:2px 4px; }
  footer { flex:0 0 auto; border-top:1px solid var(--line); background:#fff; padding:8px 12px; }
  .row { display:flex; align-items:center; gap:7px; }
  #tab-label { font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--steel);
               border:1px solid var(--line); border-radius:3px; padding:4px 7px;
               white-space:nowrap; flex:0 0 auto; }
  #tab-label.shell { color:#fff; background:var(--red); border-color:var(--red); }
  #in { flex:1 1 auto; min-width:0; background:#fff; color:var(--ink); border:1px solid var(--line);
        border-radius:5px; padding:7px 9px; font:400 12.5px/1.3 "Segoe UI",system-ui,sans-serif;
        outline:none; user-select:text; cursor:text; }
  #in:focus { border-color:rgba(239,122,30,.75); }
  #in::placeholder { color:rgba(110,118,129,.7); }
  #mic { flex:0 0 auto; font-size:9.5px; letter-spacing:.12em; text-transform:uppercase;
         border:1px solid rgba(110,118,129,.5); border-radius:3px; padding:5px 8px;
         background:rgba(255,255,255,.5); color:var(--steel); cursor:pointer; }
  #mic:hover { border-color:var(--steel); }
  #mic.muted { color:#fff; background:var(--red); border-color:var(--red); }
  #hint { margin-top:6px; font-size:9.5px; letter-spacing:.05em; color:rgba(110,118,129,.85); }
  #hint b { color:var(--steel); }
  body.dropping { outline:2px dashed rgba(88,166,255,.55); outline-offset:-4px; }
  .spin { color:#b3540f; }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style>
</head>
<body>
  <header>
    <div id="orb-dot" title="Ade OS status"></div>
    <h1>Ade</h1>
    <span id="brain"></span>
  </header>
  <div id="tabs">
    <button class="tab on" data-tab="chat" type="button">Chat</button>
    <button class="tab" data-tab="shell" type="button">Shell</button>
    <button class="tab" data-tab="task" type="button">Task</button>
  </div>
  <div id="skills"></div>
  <main id="thread"></main>
  <footer>
    <div class="row">
      <span id="tab-label">Ask</span>
      <input id="in" type="text" spellcheck="false" autocomplete="off"
             placeholder="Tell Ade what to do…">
      <button id="mic" type="button" title="The microphone is open. Click to stop the track.">Mute</button>
    </div>
    <div id="hint">Enter to send · <b>!</b> shell (ungated) · <b>?</b> ask · <b>/type</b> task type · <b>/skill</b> attach a procedure · <b>/upload</b> files, or drop them here · <b id="talkKey">tray menu</b> to speak · Esc to hide</div>
  </footer>
  <script src="chat.js"></script>
</body>
</html>
```

- [ ] **Step 6: Create `chat.js` (skeleton: tabs + threads + mic mirror + header)**

Create `chat.js` — this task delivers the shell only; `classify`/`send` join in Task 3, approvals in Task 4, voice in Task 5:

```js
/* The chat window: three persistent threads (Chat / Shell / Task) behind tabs,
 * replacing the under-glyph command bar as the conversation surface.
 *
 * All command-facing logic for the avatar converges HERE -- classify(),
 * dispatchTask(), applyAskResult(), runVoice() -- so typing and recognition
 * can never drift apart. The glyph renderer owns the microphone and the wake
 * gate; when speech survives it, the glyph sends a `chat:speech` event through
 * main and this window turns it into a message, never the other way around.
 */
'use strict';
(function () {
  var B = window.adeBridge;
  var threadEl = document.getElementById('thread');
  var input = document.getElementById('in');
  var tabLabel = document.getElementById('tab-label');
  var hint = document.getElementById('hint');
  var HINT = hint.innerHTML;
  var micBtn = document.getElementById('mic');
  var state = { online: false, busy: false, pending: 0, brain: '', approval: null };

  var TABS = ['chat', 'shell', 'task'];
  var activeTab = 'chat';
  var threads = { chat: [], shell: [], task: [] };

  /* -------------------------------------------------------- threads */
  var persistTimer = 0;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = 0;
      if (B) B.threadsSave({ chat: threads.chat, shell: threads.shell, task: threads.task });
    }, 300);          /* main debounces the actual file write again */
  }
  function push(tab, role, kind, text, meta) {
    var m = { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
              ts: Date.now(), tab: tab, role: role, kind: kind,
              text: String(text == null ? '' : text), meta: meta || {} };
    threads[tab].push(m);
    if (tab === activeTab) renderThread();
    persist();
    return m;
  }
  window.__threads = function () { return threads; };

  function renderThread() {
    var list = threads[activeTab];
    threadEl.innerHTML = '';
    for (var i = 0; i < list.length; i++) threadEl.appendChild(renderMsg(list[i]));
    threadEl.scrollTop = threadEl.scrollHeight;
  }
  function renderMsg(m) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role;
    if (m.role === 'system') {
      wrap.className = 'sys';
      wrap.textContent = m.text;
      return wrap;
    }
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.text;
    wrap.appendChild(b);
    if (m.meta && m.meta.from) {
      var f = document.createElement('div');
      f.className = 'meta';
      f.textContent = 'From: ' + m.meta.from;
      wrap.appendChild(f);
    }
    if (m.meta && m.meta.engine) {
      var e = document.createElement('span');
      e.className = 'meta';
      e.textContent = ' · ' + m.meta.engine;
      wrap.appendChild(e);
    }
    return wrap;
  }
  window.__renderMsg = renderMsg;

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) tab = 'chat';
    activeTab = tab;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === tab);
    }
    renderThread();
    paintTabLabel();
  }
  function paintTabLabel() {
    if (activeTab === 'shell') {
      tabLabel.textContent = 'Shell';
      tabLabel.className = 'shell';
      hint.textContent = 'Direct subprocess — NOT gated by Permission.check(). Enter to run.';
    } else {
      tabLabel.textContent = 'Ask';
      tabLabel.className = '';
      hint.innerHTML = HINT;
    }
  }
  window.__setTab = setTab;
  window.__activeTab = function () { return activeTab; };

  function focusInput() { setTimeout(function () { input.focus(); input.select(); }, 30); }

  /* ------------------------------------------------------- mic mirror */
  /* The track lives in the glyph renderer; this window only mirrors it. The
     button and the tray item are two ends of one toggle -- both tell main,
     main tells the glyph renderer. */
  function setMicUi(live) {
    micBtn.textContent = live ? 'Mute' : 'Unmute';
    micBtn.classList.toggle('muted', !live);
    micBtn.title = live ? 'The microphone is open. Click to stop the track.'
                        : 'The microphone track is stopped. Click to reopen.';
  }
  function initMic() {
    B.micStatus().then(setMicUi);
    B.onMicState(setMicUi);
    micBtn.addEventListener('click', function () { if (B) B.micToggle(); });
  }

  /* --------------------------------------------------------- header */
  function paintState() {
    var dot = document.getElementById('orb-dot');
    if (dot) {
      dot.classList.toggle('online', !!state.online);
      dot.classList.toggle('busy', !!state.busy && !state.pending);
      dot.classList.toggle('pending', state.pending > 0);
    }
    var brain = document.getElementById('brain');
    if (brain) brain.textContent = state.brain || '';
  }

  /* ------------------------------------------------------------ boot */
  function boot() {
    if (!B) return;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () { setTab(this.getAttribute('data-tab')); });
    }
    window.__threadsLoadPromise = B.threadsLoad().then(function (t) {
      if (t) threads = t;
      window.__threadsLoaded = true;
      renderThread();
    });
    B.onState(function (s) { if (s) { state = s; paintState(); } });
    B.onChatFocus(function (tab) {
      if (tab && TABS.indexOf(tab) >= 0) setTab(tab);
      renderThread();
      focusInput();
    });
    B.shortcuts().then(function (k) {
      var el = document.getElementById('talkKey');
      if (!el) return;
      var PRETTY_KEY = { Control: 'Ctrl', Super: 'Win' };
      el.textContent = (k && k.talk)
        ? String(k.talk).split('+').map(function (t) { return PRETTY_KEY[t] || t; }).join('+')
        : 'tray menu';
      HINT = hint.innerHTML;
    });
    initMic();
  }
  boot();
})();
```

- [ ] **Step 7: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `chatProbe.ok: true` (exists, hidden, resizable, taskbar, title `Ade`, tabs `chat/shell/task`, empty threads that round-trip `smoke`), and every pre-existing probe (`hit`, `voice`, `mic`, `hearing`, `keys`, `slash`, `ask`, `upload`) is still `true`.

- [ ] **Step 8: Commit**

```bash
git add preload.js main.js chat.html chat.js
git commit -m "feat(avatar): hidden desktop chat window with three persistent tab threads"
```

---

**Files:**
- Create: `threads-store.js`
- Test: `tests/threads-store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadThreads(file)` → `{ chat: msg[], shell: msg[], task: msg[] }`; `saveThreads(file, data)`; `defaultThreads()`; `MAX_MESSAGES = 4000`. Message shape: `{ id, ts, tab, role, kind, text, meta }` (unvalidated passthrough — the renderer owns the shape).

- [ ] **Step 1: Write the failing test**

Create `tests/threads-store.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/threads-store.test.js`
Expected: FAIL — `Cannot find module '../threads-store'`

- [ ] **Step 3: Write minimal implementation**

Create `threads-store.js`:

```js
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

function defaultThreads() {
  return { chat: [], shell: [], task: [] };
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
  return out;
}

function saveThreads(file, data) {
  const out = defaultThreads();
  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    if (Array.isArray(data && data[tab])) out[tab] = data[tab].slice(-MAX_MESSAGES);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
}

module.exports = { loadThreads, saveThreads, defaultThreads, MAX_MESSAGES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/threads-store.test.js`
Expected: PASS — `# pass 5`

- [ ] **Step 5: Commit**

```bash
git add threads-store.js tests/threads-store.test.js
git commit -m "feat(avatar): persistent thread store for the chat window tabs"
```

---

### Task 3: Sending into the window (single classifier, staging, skills, upload)

**Files:**
- Modify: `chat.js`
- Modify: `main.js` (`startSmokeRun`: new `slashChat` and `askChat` probes)
- Test: `--smoke`

**Interfaces:**
- Consumes: Task 2's `threads`, `push(tab, role, kind, text, meta)`, `setTab`, `input`, `paintTabLabel`, `focusInput`.
- Produces (in `chat.js`, `__`-exported for smoke): `classify` (the single classifier, verbatim port of the bar's), `routePlain(raw)` (active tab picks the default route for unprefixed input; `!`/`?`/`/` always override), `send(text)`, `applyAskResult(result)` (escalation stages into the Task input and NEVER dispatches), `__dispatchCount`, `handleSkill`, `handleUpload`, `readReply`, `speakText`/`stopSpeaking`. Task 4 and Task 5 consume these.

- [ ] **Step 1: Write the failing smoke probes**

In `main.js` `startSmokeRun()`, insert immediately BEFORE the `console.log('SMOKE ' + JSON.stringify({` line:

```js
    /* The single classifier lives in the chat window now. Same contracts the
       bar's probes protected, asserted against the REAL functions. */
    let slashChat = {};
    try {
      const js = (s) => chatWin.webContents.executeJavaScript(s);
      slashChat.skillVerb = await js('JSON.stringify(window.__classify("/skill"))');
      slashChat.skillNamed = await js('JSON.stringify(window.__classify("/skill brainstorming"))');
      slashChat.typeKeepsWord = await js('window.__classify("/superpowers").type');
      slashChat.typeWithBody = await js('window.__classify("/qa run the suite").text');
      slashChat.plainAsksNow = JSON.parse(await js('JSON.stringify(window.__classify("fix the build"))'));
      slashChat.route = JSON.parse(await js(
        'JSON.stringify((function(){ window.__setTab("task"); var t = window.__routePlain("run it");' +
        ' window.__setTab("chat"); var c = window.__routePlain("what is here");' +
        ' var s = window.__routePlain("!git status");' +
        ' return { shell: s, taskPlain: t, chatPlain: c }; })())'));
      slashChat.routeOk = slashChat.route.shell.kind === 'shell'
        && slashChat.route.taskPlain.kind === 'task' && slashChat.route.taskPlain.type === 'coding'
        && slashChat.route.chatPlain.kind === 'ask' && slashChat.route.chatPlain.route === 'ground';
      slashChat.ok = JSON.parse(slashChat.skillVerb).kind === 'skill'
        && JSON.parse(slashChat.skillNamed).text === 'brainstorming'
        && slashChat.typeKeepsWord === 'superpowers'
        && slashChat.typeWithBody === 'run the suite'
        && slashChat.plainAsksNow.kind === 'ask'
        && slashChat.plainAsksNow.route === 'ground'
        && slashChat.routeOk === true;
    } catch (e) { slashChat = { error: String((e && e.message) || e) }; }

    /* Ask contracts on the new surface: escalation stages a Task in the chat
       window's input and NEVER dispatches; a grounded answer clears it. */
    let askChat = {};
    try {
      const js = (s) => chatWin.webContents.executeJavaScript(s);
      const bareRoute = JSON.parse(await js('JSON.stringify(window.__classify("what is in glyph.js"))'));
      const taskRoute = JSON.parse(await js('JSON.stringify(window.__classify("/qa run the suite"))'));
      const shellRoute = JSON.parse(await js('JSON.stringify(window.__classify("!git status"))'));
      const chatRoute = JSON.parse(await js('JSON.stringify(window.__classify("?what brain are you on"))'));
      askChat.bareInputAsks = bareRoute.kind === 'ask' && bareRoute.route === 'ground';
      askChat.prefixStillDispatches = taskRoute.kind === 'task' && taskRoute.type === 'qa';
      askChat.shellUnchanged = shellRoute.kind === 'shell';
      askChat.explicitAskUnchanged = chatRoute.kind === 'ask' && chatRoute.route === 'chat';

      const before = await js('window.__dispatchCount()');
      await js('window.__applyAskResult({ answer: "", escalate: { task_type: "coding", prompt: "fix it" } })');
      const after = await js('window.__dispatchCount()');
      askChat.escalationDoesNotDispatch = after === before;
      askChat.escalationStagesTask = await js('document.getElementById("in").value') === '/coding fix it';

      const namedRootOut = await js(
        '(function(){ window.__setTab("chat");' +
        ' window.__applyAskResult({ answer: "", escalate: { task_type: "coding", prompt: "fix it", root: "D:\\\\tradinglocal" } });' +
        ' return document.getElementById("thread").textContent; })()');
      askChat.escalationNamesRoot = namedRootOut.indexOf('D:\\tradinglocal') >= 0;

      const answered = await js(
        '(function(){ document.getElementById("in").value = "leftover";' +
        ' window.__applyAskResult({ answer: "glyph.js draws the core.", roots_cited: ["ade-ai"] });' +
        ' return document.getElementById("in").value; })()');
      askChat.clearsInputOnAnswer = answered === '';

      askChat.ok = askChat.bareInputAsks && askChat.prefixStillDispatches
        && askChat.shellUnchanged && askChat.explicitAskUnchanged
        && askChat.escalationDoesNotDispatch === true
        && askChat.escalationStagesTask && askChat.escalationNamesRoot
        && askChat.clearsInputOnAnswer;
    } catch (e) { askChat = { error: String((e && e.message) || e) }; }

    /* Retry on failure (spec Error handling): a failed call stages the ORIGINAL
       line back into the input so Enter is the retry action. */
    let retryChat = {};
    try {
      ipcMain.removeHandler('ade:call');
      ipcMain.handle('ade:call', async (_e, pathname, method, body) => {
        retryChat.posted = { pathname, method, body };
        return { ok: false, status: 503, error: 'test outage' };
      });
      await js('window.__setTab("chat"); window.__send("?what brain are you on"),0');
      await new Promise((r) => setTimeout(r, 120));
      retryChat.bubble = (await js('document.getElementById("thread").textContent'))
        .indexOf('test outage') >= 0;
      retryChat.staged = (await js('document.getElementById("in").value'))
        .indexOf('?what brain are you on') >= 0;
      await js('window.__send(),0');   /* the staged line is still in the input */
      await new Promise((r) => setTimeout(r, 120));
      retryChat.resent = !!(retryChat.posted
        && retryChat.posted.method === 'POST'
        && retryChat.posted.pathname === '/v1/chat/completions'
        && retryChat.posted.body.messages[0].content === 'what brain are you on');
      retryChat.ok = retryChat.bubble && retryChat.staged && retryChat.resent;
    } catch (e) { retryChat = { error: String((e && e.message) || e) }; }
```

Add `slashChat,`, `askChat,` and `retryChat,` to the SMOKE summary object after the `chatProbe,` line.

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `slashChat`/`askChat` land in the `catch` (functions not defined in `chat.js` yet).

- [ ] **Step 3: Implement `chat.js` command surface**

Inside the `(function () { ... })()` closure, insert the following new sections immediately BEFORE the `/* ------------------------------------------------------------ boot */` comment (replacing the marker comment inside Task 2's `paintTabLabel` lives untouched). First the speech section, then classifier, routing, dispatch/send, ask-result, skills, upload. Then the input keydown handler and copy helper go inside `boot()` after the tab wiring.

```js
  /* -------------------------------------------------------------- speech */
  /* Ade's reply is decoded from base64 WAV straight into Web Audio -- no blob
     URL, so the page keeps its `default-src 'none'` policy. */
  var actx = null, speakSrc = null, speakAn = null, speakRaf = 0, speakBuf = null;

  function stopSpeaking() {
    if (speakRaf) { cancelAnimationFrame(speakRaf); speakRaf = 0; }
    if (speakSrc) { try { speakSrc.onended = null; speakSrc.stop(); } catch (e) {} speakSrc = null; }
    speakAn = null;
  }

  async function speakText(text) {
    if (!B || !text) return;
    var r = await B.speak(text);
    if (!r || !r.ok) return;
    stopSpeaking();
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') await actx.resume();
      var raw = atob(r.wav), n = raw.length, bytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) bytes[i] = raw.charCodeAt(i);
      var buf = await actx.decodeAudioData(bytes.buffer);
      var src = actx.createBufferSource(); src.buffer = buf;
      src.connect(actx.destination);
      speakSrc = src;
      src.onended = stopSpeaking;
      src.start();
    } catch (e) { stopSpeaking(); }
  }
  window.__stopSpeaking = stopSpeaking;

  /* ------------------------------------------------------------- classify */
  /* The ONE classifier for the avatar's command surface. The active tab decides
     the DEFAULT route for a plain line (routePlain); the three prefixes always
     override, and spokenToTyped (Task 5) rewrites spoken English into these
     same prefixes so speech and typing cannot drift. */
  var SKILL_VERBS = { skill: 1, skills: 1, unskill: 1 };
  var UPLOAD_VERBS = { upload: 1, uploads: 1 };

  function classify(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (v.charAt(0) === '!') return { kind: 'shell', text: v.slice(1).trim() };
    if (v.charAt(0) === '?') return { kind: 'ask', text: v.slice(1).trim(), route: 'chat' };
    if (v.charAt(0) === '/') {
      var m = v.slice(1).match(/^(\S+)\s*([\s\S]*)$/);
      var word = m ? m[1] : '';
      var body = m ? m[2].trim() : '';
      if (SKILL_VERBS[word.toLowerCase()]) return { kind: 'skill', verb: word.toLowerCase(), text: body };
      if (UPLOAD_VERBS[word.toLowerCase()]) return { kind: 'upload', verb: word.toLowerCase(), text: body };
      return { kind: 'task', type: word, text: body };
    }
    return { kind: 'ask', text: v, route: 'ground' };
  }
  window.__classify = classify;

  /* A plain line (no prefix) routes by the active tab. classify() still owns
     everything prefixed. */
  function routePlain(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (/^[!?/]/.test(v)) return classify(v);
    if (activeTab === 'shell') return { kind: 'shell', text: v };
    if (activeTab === 'task') return { kind: 'task', type: 'coding', text: v };
    return classify(v);                          /* chat default: grounded ask */
  }
  window.__routePlain = routePlain;

  function readReply(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (d.choices && d.choices[0] && d.choices[0].message) return d.choices[0].message.content || '';
    var keys = ['output', 'result', 'answer', 'reply', 'message', 'summary', 'detail', 'error'];
    for (var i = 0; i < keys.length; i++) {
      var v = d[keys[i]];
      if (typeof v === 'string' && v.trim()) return v;
    }
    if (d.task_id) return 'task ' + d.task_id + ' accepted';
    try { return JSON.stringify(d, null, 2); } catch (e) { return String(d); }
  }

  /* -------------------------------------------------------------- send */
  var taskDispatchCount = 0;
  function dispatchTask(payload) {
    taskDispatchCount++;
    return B.call('/v1/tasks', 'POST', payload);
  }
  window.__dispatchCount = function () { return taskDispatchCount; };

  function askQuestion(question) {
    return B.call('/v1/ask', 'POST', { question: question });
  }

  async function emptyHelp(c) {
    if (c.kind === 'shell') return 'Type a command after ! — e.g. !git status';
    if (c.kind === 'ask') return 'Type a question after ? — e.g. ?what brain are you on';
    var r = await B.call('/v1/task-types', 'GET');
    var types = (r && r.ok && r.data && r.data.types) || [];
    var names = types.map(function (t) { return t.type; });
    var known = names.indexOf(c.type) >= 0;
    return (known
        ? '/' + c.type + ' needs something to do — e.g. /' + c.type + ' run the tests.'
        : '"' + c.type + '" is not a task type.')
      + (names.length ? '\n\nTypes: ' + names.join(', ') : '')
      + '\n\nOr /skill <name> to attach a procedure.';
  }

  var busy = false;
  async function send(text) {
    var raw = (text === undefined) ? input.value : String(text);
    if (!raw.trim() || busy || !B) return;
    var c = routePlain(raw);
    var targetTab = c.kind === 'shell' ? 'shell' : c.kind === 'ask' ? 'chat' : 'task';
    if (c.kind === 'skill') { await handleSkill(c); return; }
    if (c.kind === 'upload') { await handleUpload(c); return; }
    if (!c.text) { push(targetTab, 'system', 'staged', await emptyHelp(c)); return; }

    stopSpeaking();
    busy = true;
    var userText = c.kind === 'shell' ? '! ' + c.text
                 : c.kind === 'task' ? '/' + (c.type || 'coding') + ' ' + c.text
                 : raw;
    push(targetTab, 'user', c.kind, userText);
    setTab(targetTab);
    input.value = '';
    paintTabLabel();

    var res;
    if (c.kind === 'shell') {
      res = await B.call('/v1/terminal', 'POST', { cmd: c.text });
    } else if (c.kind === 'ask' && c.route === 'ground') {
      res = await askQuestion(c.text);
    } else if (c.kind === 'ask') {
      res = await B.call('/v1/chat/completions', 'POST', {
        messages: [{ role: 'user', content: c.text }], stream: false
      });
    } else {
      res = await dispatchTask({
        description: c.text, task_type: c.type || 'coding', topic: 'u/local/avatar',
        skills: attached.slice()
      });
    }

    busy = false;
    if (!res || !res.ok) {
      /* A failure must not eat the user's line (spec Error handling). The
         error bubble names the cause and the ORIGINAL line is staged back
         into the input with focus -- press Enter to retry. */
      push(targetTab, 'ade', 'error',
        ('Call failed: ' + ((res && (res.error || ('HTTP ' + res.status))) || 'no response from Ade OS'))
        + '\n\nThe message is staged in the input — press Enter to retry.');
      input.value = userText;
      paintTabLabel();
      focusInput();
      return;
    }

    if (c.kind === 'ask' && c.route === 'ground') { applyAskResult(res.data); return; }

    var outText = readReply(res.data);
    var outKind = c.kind === 'task' ? 'task' : c.kind === 'shell' ? 'shell' : 'ask';
    push(targetTab, 'ade', outKind, outText || '(no output)');
    if (outText && await B.speakEnabled()) speakText(outText);
  }
  window.__send = send;

  /* The one place a /v1/ask reply becomes UI. An escalation does NOTHING but
     stage into the Task tab input -- dispatchTask() is the only road to
     /v1/tasks and this function never takes it. */
  function applyAskResult(result) {
    result = result || {};
    var text = result.answer || '';
    if (result.roots_cited && result.roots_cited.length) {
      text = (text ? text + '\n\n' : '') + 'From: ' + result.roots_cited.join(', ');
    }
    if (result.escalate) {
      var where = result.escalate.root ? (' in ' + result.escalate.root) : '';
      setTab('task');
      push('task', 'system', 'staged',
        (text ? text + '\n\n' : '') + 'Staged as a task' + where + ' — press Enter to run it, or edit first.');
      input.value = '/' + (result.escalate.task_type || 'coding') + ' ' + (result.escalate.prompt || '');
      paintTabLabel();
      focusInput();
    } else {
      input.value = '';
      push('chat', 'ade', 'ask', text || '(no output)');
    }
    return text;
  }
  window.__applyAskResult = applyAskResult;

  /* ---------------------------------------------- attached procedures */
  /* Names only. They ride every task this window dispatches and are merged
     into the agent's SYSTEM PROMPT server-side. They never widen the tool
     allowlist. */
  var attached = [];
  var skillIndex = null;

  function paintSkills() {
    var box = document.getElementById('skills');
    if (!box) return;
    box.innerHTML = '';
    for (var i = 0; i < attached.length; i++) {
      var chip = document.createElement('span');
      chip.textContent = attached[i];       /* textContent: never parsed */
      box.appendChild(chip);
    }
    box.classList.toggle('show', attached.length > 0);
  }

  async function loadSkillIndex() {
    if (skillIndex) return skillIndex;
    var r = await B.call('/v1/skills', 'GET');
    if (!r || !r.ok) return null;
    skillIndex = (r.data && r.data.skills) || [];
    return skillIndex;
  }

  async function handleSkill(c) {
    var rows = await loadSkillIndex();
    if (!rows) { push(activeTab, 'ade', 'error', 'Could not read the skills index from Ade OS.'); return; }
    var wanted = c.text.replace(/^-/, '').trim();
    var removing = c.verb === 'unskill' || /^-/.test(c.text);
    if (!wanted) {
      var on = attached.length ? 'Attached: ' + attached.join(', ') + '\n\n' : '';
      var names = rows.filter(function (s) { return s.attachable; })
                      .map(function (s) { return s.name; });
      var tooBig = rows.filter(function (s) { return !s.attachable; })
                       .map(function (s) { return s.name; });
      push(activeTab, 'system', 'staged',
        on + '/skill <name> to attach, /unskill <name> to remove.\n\n'
        + names.length + ' available:\n' + names.join(', ')
        + (tooBig.length
           ? '\n\nToo large to attach (over the cap): ' + tooBig.join(', ')
           : ''));
      return;
    }
    var row = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].name === wanted) row = rows[i];
    if (!row) { push(activeTab, 'ade', 'error', 'No skill named "' + wanted + '". /skill lists them.'); return; }
    if (removing) {
      attached = attached.filter(function (n) { return n !== wanted; });
      paintSkills();
      push(activeTab, 'ade', 'text', 'Detached ' + wanted + '.');
    } else if (!row.attachable) {
      push(activeTab, 'ade', 'error',
        wanted + ' is ' + row.chars + ' characters and will not fit the system prompt. Not attaching it.');
    } else if (attached.indexOf(wanted) >= 0) {
      push(activeTab, 'ade', 'text', wanted + ' is already attached.');
    } else {
      attached.push(wanted);
      paintSkills();
      push(activeTab, 'ade', 'text',
        'Attached ' + wanted + '. It governs every task from this window until you /unskill it.');
    }
    input.value = '';
    paintTabLabel();
  }

  /* ------------------------------------------------------- file upload */
  function uploadReport(r) {
    if (!r) return 'Upload failed: no reply from the main process.';
    var lines = [];
    lines.push(r.sent + ' of ' + r.found + ' file(s) uploaded'
               + (r.bytes ? ' (' + Math.round(r.bytes / 1024) + ' KB)' : '')
               + ' into uploads/.');
    if (r.skipped && r.skipped.length) {
      lines.push('');
      lines.push('Skipped ' + r.skipped.length + ':');
      for (var i = 0; i < Math.min(8, r.skipped.length); i++) {
        lines.push('  ' + r.skipped[i].path + ' — ' + r.skipped[i].why);
      }
      if (r.skipped.length > 8) lines.push('  … and ' + (r.skipped.length - 8) + ' more');
    }
    if (r.failed && r.failed.length) {
      lines.push('');
      lines.push('Failed ' + r.failed.length + ':');
      for (var j = 0; j < Math.min(8, r.failed.length); j++) {
        lines.push('  ' + r.failed[j].path + ' — ' + r.failed[j].why);
      }
    }
    if (r.sent) {
      lines.push('');
      lines.push('Ade can read these — ask it about uploads/<name>.');
    }
    return lines.join('\n');
  }

  async function doUpload(paths, overwrite) {
    if (!paths || !paths.length) { push(activeTab, 'ade', 'error', 'Nothing selected.'); return; }
    busy = true;
    push(activeTab, 'ade', 'text', '…uploading');      /* replaced by the report */
    var r = await B.upload(paths, !!overwrite);
    busy = false;
    push(activeTab, (r && r.failed && r.failed.length && !r.sent) ? 'error' : 'ade',
         'text', uploadReport(r));
  }

  async function handleUpload(c) {
    var wantFolder = /^folder|^dir/i.test(c.text || '');
    var paths = await B.pick(wantFolder);
    input.value = '';
    paintTabLabel();
    await doUpload(paths, /overwrite/i.test(c.text || ''));
  }
  window.__handleUpload = handleUpload;
```

And in `boot()`, after the tab loop wiring, add the copy helper and the input keydown handler:

```js
    function selectedText() {
      var s = window.getSelection();
      if (s && s.toString()) return s.toString();
      var list = threads[activeTab];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].role === 'ade' && list[i].text) return list[i].text;
      }
      return '';
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); void send(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (B) B.hideChat(); }
      else if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !window.getSelection().toString()) {
        if (B) B.copy(selectedText());
      }
    });
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `slashChat.ok` true (classifier contracts + tab routing), `askChat.ok` true (escalation stages, never dispatches, names the root, clears input on answer), `retryChat.ok` true (failed call bubbles its cause, stages the line, Enter re-sends), `chatProbe.ok` still true, all pre-existing probes unchanged/true.

- [ ] **Step 5: Commit**

```bash
git add chat.js main.js
git commit -m "feat(avatar): the chat window sends -- one classifier, tab routing, staged escalations"
```

---

### Task 4: Approvals in the window (card in the Task tab, auto-raise, decided state)

**Files:**
- Modify: `chat.html` (CSS for the approval card)
- Modify: `chat.js` (`renderMsg` approval branch, `handleState`, `showApprovalId`, `decide`, boot wiring)
- Modify: `main.js` (`startSmokeRun`: new `smsApproval` probe)
- Test: `--smoke`

**Interfaces:**
- Consumes: Task 2's `push`/`renderThread`/`setTab`/`paintState`/`state`, Task 3's expose pattern.
- Produces (in `chat.js`): `handleState(s)` (drives both the header dot and approval changes from one place), `showApprovalId(a)` (new id → append card to Task tab + `openChat('task')`; repeated/current id → no-op), `lastApprovalCardId()`, `decide(m, allow)` (POSTs `/v1/approvals/<id>/decide`, marks the card's `meta.decided`, appends a result bubble), `__showApproval`/`__handleState`/`__decide` exports. Kill/replace: nothing on the glyph side — the orb's amber pending look is `glyph.js` reading `state.pending` and is untouched.

- [ ] **Step 1: Write the failing smoke probe**

In `main.js` `startSmokeRun()`, insert immediately BEFORE the `console.log('SMOKE ' + JSON.stringify({` line (after the Task 3 block, so execution order is `chatProbe` → `slashChat` → `askChat` → `smsApproval`):

```js
    /* Approvals moved into the chat window with the bar. A new undecided
       approval appends a card into the Task tab and RAISES the window (the
       orb's amber pending look is glyph.js reading state.pending and does not
       move); Allow/Deny posts /v1/approvals/<id>/decide and marks the card;
       the same id never double-appends. Driven renderer-side so the probe owes
       the network nothing -- pollAde()'s arrival only decides WHICH id, the
       card logic is here. */
    let smsApproval = {};
    try {
      const js = (s) => chatWin.webContents.executeJavaScript(s);
      const posted = [];
      ipcMain.removeHandler('ade:call');
      ipcMain.handle('ade:call', async (_e, pathname, method, body) => {
        posted.push({ pathname, method, body });
        return { ok: true, status: 200, data: { ok: true } };
      });
      try {
        await js('window.__showApproval({ id: "s1", tool: "fs.write_file", args: { path: "C:\\\\tmp\\\\note.txt", mode: "w" } }),0');
        await new Promise((r) => setTimeout(r, 160));   /* chat:open round trip */
        smsApproval.raised = chatWin.isVisible();
        smsApproval.tab = await js('window.__activeTab()');
        smsApproval.cards = await js('document.querySelectorAll("#thread .msg.approval").length');
        smsApproval.namesTool = (await js('document.getElementById("thread").textContent')).indexOf('fs.write_file') >= 0;
        smsApproval.buttons = await js('document.querySelectorAll("#thread button.approve, #thread button.deny").length');

        await js('(function(){ var b=document.querySelector("#thread button.deny");' +
                 ' b.dispatchEvent(new MouseEvent("click",{bubbles:true})); })(),0');
        await new Promise((r) => setTimeout(r, 160));
        const decidePost = posted.find((p) => p.pathname === '/v1/approvals/s1/decide');
        smsApproval.decidePosted = !!decidePost && decidePost.method === 'POST'
          && decidePost.body && decidePost.body.allow === false
          && decidePost.body.decided_by === 'human';
        smsApproval.buttonsAfterDecide = await js('document.querySelectorAll("#thread button.approve, #thread button.deny").length');
        smsApproval.decidedText = (await js('document.getElementById("thread").textContent')).indexOf('Denied s1') >= 0;

        await js('window.__showApproval({ id: "s1", tool: "fs.write_file", args: { path: "x" } }),0');
        await new Promise((r) => setTimeout(r, 60));
        smsApproval.noDupe = (await js('document.querySelectorAll("#thread .msg.approval").length')) === 1;

        await js('window.__showApproval({ id: "s2", tool: "shell.exec", args: { cmd: "whoami" } }),0');
        await new Promise((r) => setTimeout(r, 160));
        smsApproval.secondCard = (await js('document.querySelectorAll("#thread .msg.approval").length')) === 2;

        smsApproval.ok = smsApproval.raised === true
          && smsApproval.tab === 'task'
          && smsApproval.cards === 1
          && smsApproval.namesTool === true
          && smsApproval.buttons === 2
          && smsApproval.decidePosted === true
          && smsApproval.buttonsAfterDecide === 0
          && smsApproval.decidedText === true
          && smsApproval.noDupe === true
          && smsApproval.secondCard === true;
      } finally {
        await js('window.adeBridge.hideChat(),0').catch(() => {});
        await js('(function(){ var w = window.__threads();' +
                 ' w.task = w.task.filter(function(m){ return !(m.kind === "approval" && m.meta && /^s[12]$/.test(m.meta.approval && m.meta.approval.id)); });' +
                 ' window.adeBridge.threadsSave({ chat: w.chat, shell: w.shell, task: w.task }),0; })(),0').catch(() => {});
        ipcMain.removeHandler('ade:call');
        ipcMain.handle('ade:call', handleAdeCall);
      }
    } catch (e) { smsApproval = { error: String((e && e.message) || e) }; }
```

Add `smsApproval,` to the SMOKE summary object after the `askChat,` line.

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `smsApproval` lands in the `catch` (`__showApproval` is not defined, and `#thread .msg.approval` renders nothing).

- [ ] **Step 3: Implement approvals in `chat.js`**

**3a. `chat.html`** — append these rules to the existing `<style>` block (after the `.msg.shell`/`.sys`/`.meta` rules):

```css
  .msg.approval .approval { display:inline-block; max-width:78%; border:1px solid var(--line);
                            background:#fff8ea; border-radius:8px; padding:8px 10px;
                            font:400 12px/1.4 "Segoe UI",system-ui,sans-serif; }
  .msg.approval .what { font-weight:600; color:#4a3b04; font-family:"Cascadia Mono","Consolas",ui-monospace,monospace; font-size:11px; }
  .msg.approval .args { margin:5px 0 0; padding:6px 8px; background:rgba(110,118,129,.08);
                        border:1px solid rgba(110,118,129,.25); border-radius:5px;
                        white-space:pre-wrap; word-break:break-all; font:400 10.5px/1.4 "Consolas",monospace; }
  .msg.approval .decide-row { margin-top:7px; display:flex; gap:6px; }
  .msg.approval button { font:600 10.5px/1 "Segoe UI",sans-serif; letter-spacing:.08em;
                         text-transform:uppercase; border-radius:4px; padding:5px 14px; cursor:pointer; }
  .msg.approval button.approve { color:#fff; background:#6e9a35; border:1px solid #5c8129; }
  .msg.approval button.deny { color:var(--red); background:#fff; border:1px solid #d5aab0; }
  .msg.approval .decision { padding:2px 0; font-weight:600; color:#6e9a35; }
```

**3b. `chat.js`** — give every rendered message a `data-id` and teach `renderMsg` the approval card. In Task 2's `renderMsg`, right after `wrap.className = 'msg ' + m.role;` add:

```js
    wrap.setAttribute('data-id', m.id);
```

and, immediately after the `m.role === 'system'` block, insert:

```js
    if (m.kind === 'approval') {
      wrap.className = 'msg ade approval';
      var card = document.createElement('div');
      card.className = 'approval';
      var appr = (m.meta && m.meta.approval) || {};
      if (m.meta && m.meta.decided) {
        var d = document.createElement('div');
        d.className = 'decision';
        d.textContent = m.meta.decided === 'allow' ? 'Allowed ' + (appr.id || '')
                      : m.meta.decided === 'deny' ? 'Denied ' + (appr.id || '')
                      : m.meta.decided;
        card.appendChild(d);
      } else {
        var what = document.createElement('div');
        what.className = 'what';
        what.textContent = appr.tool || 'approval';
        card.appendChild(what);
        if (appr.args != null) {
          var args = document.createElement('pre');
          args.className = 'args';
          var argText;
          try { argText = JSON.stringify(appr.args, null, 1); } catch (e) { argText = String(appr.args); }
          args.textContent = argText;
          card.appendChild(args);
        }
        var row = document.createElement('div');
        row.className = 'decide-row';
        var allow = document.createElement('button');
        allow.type = 'button'; allow.className = 'approve'; allow.textContent = 'Allow';
        var deny = document.createElement('button');
        deny.type = 'button'; deny.className = 'deny'; deny.textContent = 'Deny';
        row.appendChild(allow);
        row.appendChild(deny);
        card.appendChild(row);
      }
      wrap.appendChild(card);
      return wrap;
    }
```

**3c.** Add the approval state machine. Insert a new section just before the `/* ------------------------------------------------------------ boot */` comment (next to Task 3's work):

```js
  /* ---------------------------------------------------------- approvals */
  /* An undecided approval is a card in the Task tab. The glyph's amber
     pending look is glyph.js reading state.pending -- this window only owns
     the decision itself. `showApprovalId` guards on the id so a 2s poll never
     doubles the card, and the raise only fires when the id CHANGES. */
  var showingApprovalId = null;

  function lastApprovalCardId() {
    var list = threads.task;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'ade' && list[i].kind === 'approval'
          && list[i].meta && list[i].meta.approval) {
        return list[i].meta.approval.id;
      }
    }
    return null;
  }

  function showApprovalId(a) {
    if (!a) { showingApprovalId = null; return; }
    var id = a.id;
    if (showingApprovalId === id && lastApprovalCardId() === id) return;   /* already up */
    showingApprovalId = id;
    if (lastApprovalCardId() !== id) {
      push('task', 'ade', 'approval', '', { approval: a });
    }
    setTab('task');
    if (B) B.openChat('task');                 /* auto-raise on a NEW approval */
  }
  window.__showApproval = showApprovalId;

  async function decide(m, allow) {
    if (!B || !m || !m.meta || !m.meta.approval || m.meta.decided) return;
    var id = m.meta.approval.id;
    m.meta.decided = allow ? 'allow' : 'deny';
    renderThread();
    var r = await B.call('/v1/approvals/' + encodeURIComponent(id) + '/decide', 'POST', {
      allow: allow,
      reason: allow ? 'allowed from the desktop avatar' : 'denied from the desktop avatar',
      decided_by: 'human'
    });
    /* the result bubble carries the decision into the thread and is persisted
       with it -- the card keeps its decided look when the window re-polls */
    push('task', 'ade', r && r.ok ? 'text' : 'error',
      r && r.ok ? (allow ? 'Allowed ' + id : 'Denied ' + id)
                : 'Could not decide ' + id + ': ' + ((r && (r.error || r.status)) || '?'));
  }
  window.__decide = decide;

  /* One click handler for every card, now and later: a decision mutates the
     message's meta so re-render and persist stay in step. */
  threadEl.addEventListener('click', function (e) {
    var btn = e.target;
    if (!btn || !btn.classList
        || !(btn.classList.contains('approve') || btn.classList.contains('deny'))
        || !btn.closest) return;
    var wrap = e.target.closest('.msg');
    if (!wrap) return;
    var id = wrap.getAttribute('data-id');
    for (var t = 0; t < TABS.length; t++) {
      var list = threads[TABS[t]];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { void decide(list[i], btn.classList.contains('approve')); return; }
      }
    }
  });

  /* The state stream drives header AND approvals from one place. Arriving
     approvals raise the window; the same id on a later poll is a no-op. */
  function handleState(s) {
    if (!s) return;
    state = s;
    paintState();
    showApprovalId(s.approval);
  }
  window.__handleState = handleState;
```

**3d.** Wire it into `boot()`. In Task 2's `boot()`, replace

```js
    B.onState(function (s) { if (s) { state = s; paintState(); } });
```

with

```js
    B.onState(handleState);
```

and add the boot-time approval seeding so the window never auto-raises for
something already waiting at launch (it renders the card into the Task tab
silently instead; a genuinely NEW id later still raises):

```js
    /* An approval already waiting at boot is "shown" already: render its card
       without raising, so the glyph's amber is the beacon and opening is the
       user's move. Later ids still raise. */
    B.state().then(function (s) {
      if (s) {
        state = s;
        paintState();
        if (s.approval) {
          showingApprovalId = s.approval.id;
          if (lastApprovalCardId() !== s.approval.id) {
            push('task', 'ade', 'approval', '', { approval: s.approval });
          }
        }
      }
    });
```

Place it after `B.onChatFocus(...)` and before `B.shortcuts().then(...)`.

- [ ] **Step 4: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `smsApproval.ok` true (raise + Task tab + one card + Allow/Deny buttons + decidable via `/v1/approvals/s1/decide` + decided look + no duplicate + second id re-raises), and `chatProbe.ok` (hidden at launch), `slashChat.ok`, `askChat.ok` all still true, all glyph probes unchanged/true.

- [ ] **Step 5: Commit**

```bash
git add chat.html chat.js main.js
git commit -m "feat(avatar): approval cards in the chat window Task tab, auto-raise on a new decision"
```

---

### Task 5: Voice relays into the window; the glyph renderer shrinks

**Files:**
- Modify: `ui.js` (rewrite — see new full content below)
- Modify: `preload.js` (add `speakGlyph`/`speakGlyphStop`)
- Modify: `main.js` (relay IPC `chat:speech`/`chat:speak`/`chat:hush`, `dialogNote` → `chatWin`; smoke: delete glyph `slash`/`ask`/`voice` blocks, add `voiceRelay` + reworked `pttSmoke`)
- Modify: `chat.js` (relay-backed speech; `spokenToTyped`/`normalizeSpoken`/`VOICE_ACTIONS`/`runVoice`/`handleSpeech`; status line; `onSpeech`+`onNote` wiring; speak the ground-ask answer)
- Test: `--smoke`

**Interfaces:**
- Consumes: Task 2's `saySpeech`/`onSpeech` bridges + `chatWin`; Task 3's `classify`/`send`/`dispatchTask`/`readReply`.
- Produces: **the ONE speech path**: glyph renderer strips the wake word and relays `{ text, engine, empty }` or `{ status }` events via `B.saySpeech(ev)` → main `chat:speech` → `chatWin`'s `handleSpeech(ev)`; chat.js classifies, opens the right tab, and either answers a ground ask or stages everything else. Audio stays with the glyph: chat.js `speakText`/`stopSpeaking` become relays (`speakGlyph`/`speakGlyphStop` → main → `ui:speak`/`ui:hush`), so the analyser that feeds the orb's mouth never moves. ui.js keeps only drag/click/hit, mic+PTT+wake, speak, and relaying.
- Audio engine decision (aligns with the design spec §"The glyph window"): the glyph window's `speakText` is the ONE place speech audio is decoded and played. The Task 3 speech section in `chat.js` (its own `AudioContext`/`atob` playback) is REPLACED here by the relay.

- [ ] **Step 1: Write the failing smoke** (delete the glyph-scoped `slash`, `ask`, and `voice`+`pttSmoke` blocks; insert `voiceRelay` which owns the reworked `pttSmoke`)

In `main.js` `startSmokeRun()`:
1. Delete the whole `let slash = {}; ... } catch (e) { slash = { error: ... }; }` block.
2. Delete the whole `let ask = {}; ... } catch (e) { ask = { error: ... }; }` block.
3. Delete the whole `let voice = {}; ... voice.ok = ...; } catch (e) { voice = ...; }` block (the one that starts at `/* Speech cannot carry the bar's prefixes...`). This removes the glyph-side `spokenToTyped`/`normalizeSpoken`/`shellNeedsConfirm`/`pttSmoke` assertions — their contracts now have chat-win homes.
4. In its place insert:

```js
    /* Speech lands in the chat window now. The glyph renderer strips the wake
       word and relays; here we drive the REAL handleSpeech/runVoice in chatWin
       and the REAL pttUp relay in the glyph against a stubbed recogniser. The
       properties: a spoken shell stages (never dispatches), a bare ask opens
       the Chat tab and dispatches exactly /v1/ask, and "stop" only cuts speech
       without opening the window. */
    let voiceRelay = {};
    try {
      const js = (s) => chatWin.webContents.executeJavaScript(s);
      const gjs = (s) => win.webContents.executeJavaScript(s);
      const posted = [];
      ipcMain.removeHandler('ade:call');
      ipcMain.handle('ade:call', async (_e, pathname, method, body) => {
        posted.push({ pathname, method, body });
        return { ok: true, status: 200, data: { stub: true } };
      });
      try {
        const rewrites = JSON.parse(await js('JSON.stringify({' +
          ' shell: window.__spokenToTyped("shell git status"),' +
          ' ask: window.__spokenToTyped("ask what brain are you on"),' +
          ' task: window.__spokenToTyped("task qa run the suite"),' +
          ' bare: window.__spokenToTyped("run the trust level tests"),' +
          ' normHealth: window.__normalizeSpoken("Check the health.") })'));
        voiceRelay.rewrites = rewrites;
        voiceRelay.rewriteOk = rewrites.shell === '!git status'
          && rewrites.ask === '?what brain are you on'
          && rewrites.task === '/qa run the suite'
          && rewrites.bare === 'run the trust level tests'
          && rewrites.normHealth === 'check the health';

        /* recognised shell text stages in the Shell tab and never dispatches */
        await js('(function(){ window.__handleSpeech({ text: "shell git status", engine: "whisper" }); })(),0');
        await new Promise((r) => setTimeout(r, 150));
        voiceRelay.shellStages = await js('document.getElementById("in").value') === '!git status';
        voiceRelay.shellTab = (await js('window.__activeTab()')) === 'shell';
        voiceRelay.shellNoDispatch = posted.every((p) =>
          p.pathname !== '/v1/terminal' && p.pathname !== '/v1/tasks');

        /* a bare (grounded) ask opens the Chat tab and dispatches exactly /v1/ask */
        posted.length = 0;
        await js('(function(){ window.__handleSpeech({ text: "what is the backlog", engine: "whisper" }); })(),0');
        await new Promise((r) => setTimeout(r, 250));
        voiceRelay.askDispatched = posted.length === 1 && posted[0].pathname === '/v1/ask';
        voiceRelay.askTab = (await js('window.__activeTab()')) === 'chat';
        voiceRelay.askOpened = chatWin.isVisible();
        voiceRelay.askBubble = (await js('document.getElementById("thread").textContent')).indexOf('what is the backlog') >= 0;

        /* stop cuts speech and opens nothing */
        await js('window.adeBridge.hideChat(),0');
        await new Promise((r) => setTimeout(r, 120));
        await js('(function(){ window.__handleSpeech({ text: "stop", engine: "whisper" }); })(),0');
        await new Promise((r) => setTimeout(r, 120));
        voiceRelay.stopDoesNotOpen = chatWin.isVisible() === false;

        /* pttSmoke: the REAL pttUp() relay path, stubbed recogniser. The glyph
           relays "shell git status"; chatWin stages it; nothing is dispatched. */
        let pttSmoke = {};
        try {
          await gjs(
            '(function(){' +
            ' window.__pttSmokeOrigStop = window.PTT.stop;' +
            ' window.__pttSmokeOrigActive = window.PTT.isActive;' +
            ' window.PTT.stop = function(){ return Promise.resolve({ ok: true, text: "shell git status" }); };' +
            ' window.PTT.isActive = function(){ return true; };' +
            ' })()');
          await gjs('window.__pttUp ? window.__pttUp() : Promise.reject(new Error("__pttUp not exposed"))');
          await new Promise((r) => setTimeout(r, 300));
          pttSmoke.chatValue = await js('document.getElementById("in").value');
          pttSmoke.chatVisible = !!chatWin && chatWin.isVisible();
          await gjs(
            '(function(){' +
            ' window.PTT.stop = window.__pttSmokeOrigStop;' +
            ' window.PTT.isActive = window.__pttSmokeOrigActive;' +
            ' delete window.__pttSmokeOrigStop; delete window.__pttSmokeOrigActive;' +
            ' })()').catch(() => {});
        } catch (e) { pttSmoke = { error: String((e && e.message) || e) }; }
        pttSmoke.dispatched = posted.map((p) => p.pathname);
        pttSmoke.noDispatch = posted.indexOf('/v1/terminal') === -1
          && posted.indexOf('/v1/tasks') === -1
          && posted.every((p) => p.indexOf('/v1/approvals') !== 0);
        pttSmoke.ok = pttSmoke.chatValue === '!git status'
          && pttSmoke.chatVisible === true
          && pttSmoke.noDispatch === true;
        voiceRelay.pttSmoke = pttSmoke;

        voiceRelay.ok = voiceRelay.rewriteOk === true
          && voiceRelay.shellStages === true
          && voiceRelay.shellTab === true
          && voiceRelay.shellNoDispatch === true
          && voiceRelay.askDispatched === true
          && voiceRelay.askTab === true
          && voiceRelay.askOpened === true
          && voiceRelay.askBubble === true
          && voiceRelay.stopDoesNotOpen === true
          && pttSmoke.ok === true;
      } finally {
        await js('window.adeBridge.hideChat(),0').catch(() => {});
        ipcMain.removeHandler('ade:call');
        ipcMain.handle('ade:call', handleAdeCall);
      }
    } catch (e) { voiceRelay = { error: String((e && e.message) || e) }; }
```

5. In the SMOKE summary object, replace `slash,` and `ask,` with `voiceRelay,`... actually remove `slash`/`ask` entries and add `voiceRelay,` (keep `slashChat,`/`askChat,` from Task 3).

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `voiceRelay` lands in the `catch` (`__handleSpeech`/`__spokenToTyped` not in `chatWin` yet, and the deleted glyph functions are already gone).

- [ ] **Step 3a: `preload.js`** — add to the chat-window surface (after `saySpeech`):

```js
  /* Ask the glyph renderer to speak/hush. The audio engine lives there (its
     analyser feeds the orb's mouth); the chat window only says WHEN. */
  speakGlyph: (text) => ipcRenderer.send('chat:speak', text),
  speakGlyphStop: () => ipcRenderer.send('chat:hush'),
```

- [ ] **Step 3b: `main.js`** — add the relay handlers next to `threads:load` in `4g`, and retarget `dialogNote`:

```js
/* voice relay: glyph renderer -> chat window (speech events), and the answers
   back (chat window -> glyph renderer, which owns the audio + the mouth). */
ipcMain.on('chat:speech', (_e, ev) => {
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:speech', ev);
});
ipcMain.on('chat:speak', (_e, text) => {
  if (win && !win.isDestroyed()) win.webContents.send('ui:speak', String(text || ''));
});
ipcMain.on('chat:hush', () => {
  if (win && !win.isDestroyed()) win.webContents.send('ui:hush');
});
```

and

```js
function dialogNote(msg) {
  const tgt = (chatWin && !chatWin.isDestroyed()) ? chatWin : win;
  if (tgt && !tgt.isDestroyed()) tgt.webContents.send('ui:note', msg);
}
```

- [ ] **Step 3c: rewrite `ui.js`** to the full content below (the shrink). Everything chat-scoped (classify, send, applyAskResult, dispatchTask, readReply, spokenToTyped, normalizeSpoken, VOICE_ACTIONS, runVoice, handleSpoken, skills, upload, approvals, `say`) is gone; the mic/PTT/wake/speak machinery and the orb's hit/drag logic stay. The old bar DOM still exists until Task 6, so `toggleBar` stays as a shim that only lends the glyph focusability:

```js
/* The avatar's orb renderer: drag it, talk to it. The command surface has
 * moved into the chat window (chat.js); THIS window now owns only
 *   - drag / click / click-through hit logic
 *   - the live microphone, push-to-talk, and the wake gate   (ptt.js)
 *   - Ade's spoken replies: the ONE audio engine, and the glyph's mouth
 * and RELAYS recognised speech to the chat window through main. Classify,
 * dispatch, approvals, skills and upload live in chat.js, never here.
 */
'use strict';
(function () {
  var B = window.adeBridge;
  var cvs = document.getElementById('glyph');

  /* -------------------------------------------------------------- speech */
  /* Ade's reply is decoded from base64 WAV straight into Web Audio -- no blob
     URL, so the page keeps its `default-src 'none'` policy. The playing signal
     also drives the glyph, which is what gives the avatar a mouth. chat.js
     asks main to relay a "speak" event here; this is the only decoder. */
  var actx = null, speakSrc = null, speakAn = null, speakRaf = 0, speakBuf = null;

  function stopSpeaking() {
    if (speakRaf) { cancelAnimationFrame(speakRaf); speakRaf = 0; }
    if (speakSrc) { try { speakSrc.onended = null; speakSrc.stop(); } catch (e) {} speakSrc = null; }
    speakAn = null;
    if (window.GLYPH) window.GLYPH.setSpeaking(0);
  }

  async function speakText(text) {
    if (!B || !text) return;
    var r = await B.speak(text);
    if (!r || !r.ok) return;
    stopSpeaking();
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') await actx.resume();
      var raw = atob(r.wav), n = raw.length, bytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) bytes[i] = raw.charCodeAt(i);
      var buf = await actx.decodeAudioData(bytes.buffer);
      var src = actx.createBufferSource(); src.buffer = buf;
      var an = actx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.55;
      src.connect(an); an.connect(actx.destination);
      speakSrc = src; speakAn = an; speakBuf = new Uint8Array(an.fftSize);
      src.onended = stopSpeaking;
      src.start();
      (function tick() {
        if (!speakAn) return;
        speakAn.getByteTimeDomainData(speakBuf);
        var sum = 0;
        for (var j = 0; j < speakBuf.length; j++) { var v = (speakBuf[j] - 128) / 128; sum += v * v; }
        var lvl = Math.min(1, Math.sqrt(sum / speakBuf.length) * 4.6);
        if (window.GLYPH) window.GLYPH.setSpeaking(lvl);
        speakRaf = requestAnimationFrame(tick);
      })();
    } catch (e) { stopSpeaking(); }
  }

  /* ------------------------------------------------------------ sizing */
  function sizeCanvas() {
    var p = new URLSearchParams(location.search);
    var s = parseInt(p.get('glyph') || '380', 10);
    cvs.style.width = window.innerWidth + 'px';
    cvs.style.height = s + 'px';
    window.dispatchEvent(new Event('resize'));
  }
  sizeCanvas();
  if (B) B.onSize(function () { setTimeout(sizeCanvas, 30); });
  window.addEventListener('resize', function () { /* glyph.js handles its own */ });

  /* -------------------------------------------------------- drag / click */
  var down = null;
  cvs.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    down = { x: e.screenX, y: e.screenY, moved: 0 };
    if (B) B.dragStart();
    e.preventDefault();
  });
  /* ------------------------------------------------------------ hit area */
  var HIT_ALPHA = 48;        /* measured off smoke.png: the backing halo is gone by here */
  var HIT_PAD = 5;           /* a one-pixel line still has to be grabbable */
  var hitOn = null, hitAt = 0;
  var probe = cvs.getContext('2d');

  function painted(px, py) {
    var cw = cvs.clientWidth, ch = cvs.clientHeight;
    if (!(cw > 0 && ch > 0) || px < 0 || py < 0 || px >= cw || py >= ch) return false;
    var d = cvs.width / cw, n = HIT_PAD * 2 + 1;
    var x = Math.max(0, Math.min(cvs.width - n, Math.round(px * d) - HIT_PAD));
    var y = Math.max(0, Math.min(cvs.height - n, Math.round(py * d) - HIT_PAD));
    var data;
    try { data = probe.getImageData(x, y, n, n).data; }
    catch (e) { return true; }
    for (var i = 3; i < data.length; i += 4) if (data[i] >= HIT_ALPHA) return true;
    return false;
  }
  function setHit(on) { if (on !== hitOn) { hitOn = on; if (B) B.hit(on); } }

  var bar = document.getElementById('bar');     /* deleted in Task 6 */
  window.addEventListener('mousemove', function (e) {
    if (down) {
      setHit(true);                   /* never drop a drag that wanders off the lines */
      down.moved = Math.max(down.moved, Math.abs(e.screenX - down.x) + Math.abs(e.screenY - down.y));
      if (down.moved > 3 && B) B.dragMove();
      return;
    }
    if (bar && bar.classList.contains('open')) { setHit(true); return; }
    var now = Date.now();
    if (now - hitAt < 16) return;
    hitAt = now;
    setHit(painted(e.clientX, e.clientY));
  });
  document.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget && !down && !(bar && bar.classList.contains('open'))) setHit(false);
  });
  window.addEventListener('mouseup', function () {
    if (!down) return;
    var wasClick = down.moved <= 3;
    down = null;
    if (B) B.dragEnd();
    if (wasClick) toggleBar();         /* Task 6 turns this into B.openChat() */
  });
  cvs.addEventListener('contextmenu', function (e) { e.preventDefault(); if (B) B.menu(); });

  /* ------------------------------------------------------ bar shim (temp) */
  /* The bar DOM survives until Task 6. Nothing in it can send any more; keeping
     its open/closed state is what lets --smoke's hit probe pass in between. */
  function toggleBar(force) {
    if (!bar) return;
    var open = force === undefined ? !bar.classList.contains('open') : !!force;
    bar.classList.toggle('open', open);
    if (B) B.bar(open);
    if (open) { var inp = document.getElementById('in'); if (inp) inp.focus(); }
    else setHit(false);
  }
  window.__toggleBar = toggleBar;
  if (B) B.onToggleBar(function () { toggleBar(); });

  /* ------------------------------------------------------- voice control */
  /* The microphone and the wake gate stay here; the UI they produce lives in
     the chat window. Speech is RELAYED as an event and chat.js decides what to
     do with it -- it never dispatches on recognition alone. */
  var WAKE = /^\s*(?:hey\s+|ok\s+)?ad[ae]y?\s*[,.!?:-]?\s+/i;

  function stripWake(text) {
    var m = String(text == null ? '' : text).match(WAKE);
    return m ? String(text).slice(m[0].length).trim() : null;
  }
  window.__stripWake = stripWake;    /* --smoke reaches it here */

  /* One utterance from the open microphone. Everything not addressed to Ade is
     dropped here, before any classification and before anything could be staged
     or dispatched. */
  function onUtterance(u) {
    if (!u || !u.text) return;
    var command = stripWake(u.text);
    if (command === null) return;                  /* not for us: discard */
    /* It was for us. Flare NOW rather than when the answer comes back: this is
       the only acknowledgement that can land while the sentence is still being
       recognised. */
    if (window.GLYPH && window.GLYPH.wake) window.GLYPH.wake();
    if (B) B.saySpeech({ text: command, engine: u.engine || '', empty: !command });
  }
  window.__onUtterance = onUtterance;

  async function pttDown() {
    if (!B || PTT.isActive()) return;
    var ok = await PTT.start(function (lvl) { if (window.GLYPH) window.GLYPH.setHearing(lvl); });
    if (!ok) { if (B) B.saySpeech({ status: 'error', text: 'Microphone unavailable.' }); return; }
    if (B) B.saySpeech({ status: 'listening' });
  }
  async function pttUp() {
    if (!B || !PTT.isActive()) return;
    if (window.GLYPH) window.GLYPH.setHearing(0);
    if (B) B.saySpeech({ status: 'recognising' });
    var r = await PTT.stop();
    if (!r.ok) { if (B) B.saySpeech({ status: 'error', text: 'Did not catch that (' + r.error + ').' }); return; }
    if (!r.text) { if (B) B.saySpeech({ empty: true, text: '' }); return; }
    if (B) B.saySpeech({ text: r.text, engine: r.engine || '' });
  }
  window.__pttUp = pttUp;   /* --smoke drives the real path with a stubbed PTT here */

  /* ------------------------------------------------------ Ade's state in */
  if (B) {
    B.onState(function (s) { if (window.GLYPH) window.GLYPH.setAde(s); });
    B.onArm(function () { if (window.GLYPH) window.GLYPH.arm(); });
    B.onSpeak(function (t) { speakText(t); });
    B.onHush(function () { stopSpeaking(); });
    B.onPttDown(function () { pttDown(); });
    B.onPttUp(function () { pttUp(); });
    B.onBacking(function (on) { if (window.GLYPH) window.GLYPH.setBacking(on); });

    /* ------------------------------------------------ the live mic */
    /* Live at launch, per Ray. `mic` defaults TRUE when the key is absent so a
       fresh install behaves as asked; the tray toggle writes it. */
    function setMicUi() {
      var live = window.PTT && window.PTT.isLive && window.PTT.isLive();
      if (window.GLYPH && window.GLYPH.setMic) window.GLYPH.setMic(live ? 1 : 0);
      var micBtn = document.getElementById('mic');     /* bar; deleted Task 6 */
      if (micBtn) {
        micBtn.textContent = live ? 'Mute' : 'Unmute';
        micBtn.classList.toggle('muted', !live);
        micBtn.title = live ? 'The microphone is open. Click to stop the track.'
                            : 'The microphone track is stopped. Click to reopen.';
      }
      if (B) B.micState(!!live);
    }
    window.__setMicUi = setMicUi;

    async function micOn() {
      var ok = await window.PTT.live(onUtterance, function (lvl) {
        if (window.GLYPH) window.GLYPH.setHearing(lvl);
      });
      if (!ok) { if (B) B.saySpeech({ status: 'error', text: 'Could not open the microphone.' }); }
      setMicUi();
      return ok;
    }
    function micOff() { window.PTT.mute(); if (window.GLYPH) window.GLYPH.setHearing(0); setMicUi(); }
    async function micToggle() { if (window.PTT.isLive()) micOff(); else await micOn(); }
    window.__micToggle = micToggle;
    B.onMicToggle(function () { void micToggle(); });

    /* The hint names the key that actually bound (lives in the chat window
       hint from Task 2 on; the glyph bar's copy is deleted with the bar). */
    var PRETTY_KEY = { Control: 'Ctrl', Super: 'Win' };
    B.shortcuts().then(function (k) {
      var el = document.getElementById('talkKey');
      if (!el) return;
      el.textContent = (k && k.talk)
        ? String(k.talk).split('+').map(function (t) { return PRETTY_KEY[t] || t; }).join('+')
        : 'tray menu';
    });
    B.config().then(function (c) {
      if (c && c.mic !== false) { void micOn(); } else { setMicUi(); }
      if (c && window.GLYPH) window.GLYPH.setBacking(c.backing !== false);
    });
    B.state().then(function (s) { if (s && window.GLYPH) window.GLYPH.setAde(s); });
  }
})();
```

(The `interact`/`hit`/`mic`/`hearing`/`keys` smoke blocks keep passing against these functions; their bar-dependent asserts are reworked in Task 6.)

- [ ] **Step 3d: `chat.js`** — four edits.

**1. Replace the Task 3 speech section** (the whole `actx`/`speakText`/`stopSpeaking` block ending with `window.__stopSpeaking = stopSpeaking;`) with the relay:

```js
  /* -------------------------------------------------------------- speech */
  /* The audio engine lives in the glyph renderer -- its analyser drives the
     orb's mouth -- so the chat window only decides WHEN to speak and asks main
     to relay. It never decodes audio itself. */
  function speakText(text) {
    if (!B || !text) return;
    if (B.speakGlyph) B.speakGlyph(text);
  }
  function stopSpeaking() { if (B && B.speakGlyphStop) B.speakGlyphStop(); }
  window.__stopSpeaking = stopSpeaking;
```

**2. In `send()`, speak a grounded answer** — replace

```js
    if (c.kind === 'ask' && c.route === 'ground') { applyAskResult(res.data); return; }
```

with

```js
    if (c.kind === 'ask' && c.route === 'ground') {
      var spoken = applyAskResult(res.data);
      if (spoken && await B.speakEnabled()) speakText(spoken);
      return;
    }
```

**3. Add the voice section.** Insert immediately after the `applyAskResult` block (after `window.__applyAskResult = applyAskResult;`, before the `/* ----- attached procedures */` comment):

```js
  /* ------------------------------------------------------- voice control */
  /* One set of rules for typed AND spoken commands (see spokenToTyped):
     speech is rewritten through the window's prefixes and the SAME
     classifier runs. Everything dispatched here only ever reached /v1/tasks
     through dispatchTask(), which an escalation never calls.
     Whisper capitalises and adds terminal punctuation, but the voice-action
     keys are bare lowercase phrases -- normalizeSpoken collapses the two. */
  var SPOKEN_PREFIX = [
    { re: /^\s*shell\s+/i, out: '!' },
    { re: /^\s*ask\s+/i, out: '?' },
    { re: /^\s*task\s+(\S+)\s+/i, out: '/' }
  ];
  function spokenToTyped(text) {
    var v = String(text == null ? '' : text).trim();
    for (var i = 0; i < SPOKEN_PREFIX.length; i++) {
      var m = v.match(SPOKEN_PREFIX[i].re);
      if (!m) continue;
      if (SPOKEN_PREFIX[i].out === '/') return '/' + m[1] + ' ' + v.slice(m[0].length);
      return SPOKEN_PREFIX[i].out + v.slice(m[0].length);
    }
    return v;
  }
  window.__spokenToTyped = spokenToTyped;

  function normalizeSpoken(text) {
    return String(text == null ? '' : text).trim().replace(/[.!?,;:]+$/, '').toLowerCase();
  }
  window.__normalizeSpoken = normalizeSpoken;

  var VOICE_ACTIONS = {
    'check the health':     { read: '/v1/health' },
    'what is pending':      { read: '/v1/approvals' },
    'list the agents':      { read: '/v1/agents' },
    'what are you doing':   { read: '/v1/activity' },
    'show the backlog':     { read: '/v1/pm/backlog' },
    'run the tests':        { task: 'run the full test suite and report failures', type: 'generate_artifacts' },
    'read the file':        { prompt: 'read the file ' },
    'open the command window': { ui: 'window' },
    'stop':                 { ui: 'stop' }
  };

  /* Transient status line ("…listening" / "…recognising") that never survives
     in the persisted thread: it is replaced by later statuses and dropped by
     any real message. */
  var statusMsg = null;
  function removeMsg(m) {
    for (var t = 0; t < TABS.length; t++) {
      var list = threads[TABS[t]];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === m.id) { list.splice(i, 1); break; }
      }
    }
    if (m && m.tab === activeTab) renderThread();
    persist();
  }
  function sayStatus(kind) {
    var text = kind === 'listening' ? '…listening'
             : kind === 'recognising' ? '…recognising' : '';
    if (!text) { if (statusMsg) { removeMsg(statusMsg); statusMsg = null; } return; }
    if (statusMsg) { statusMsg.text = text; renderThread(); persist(); }
    else { statusMsg = push('chat', 'system', 'staged', text); }
  }
  window.__sayStatus = sayStatus;

  /* A configured voice action. Reads answer into the Chat tab; "read the file"
     stages its prompt; "open the command window" opens it; "stop" only
     cuts speech and opens NOTHING -- the one exception to the auto-open. */
  async function runVoice(phrase, engine) {
    var act = VOICE_ACTIONS[phrase];
    if (!act) { push('chat', 'ade', 'error', 'Heard "' + phrase + '" — no action bound to it.'); return; }
    if (act.ui === 'stop') { stopSpeaking(); return; }
    if (act.ui === 'window') {
      setTab('chat'); if (B) B.openChat('chat'); focusInput();
      return;
    }
    if (act.prompt) {
      setTab('chat'); if (B) B.openChat('chat');
      input.value = act.prompt; paintTabLabel(); focusInput();
      return;
    }
    if (B) B.openChat('chat');
    setTab('chat');
    push('chat', 'user', 'task', phrase);
    var r;
    if (act.read) r = await B.call(act.read, 'GET', null);
    else r = await dispatchTask(
      { description: act.task, task_type: act.type || 'coding', topic: 'u/local/avatar' });
    if (!r || !r.ok) { push('chat', 'ade', 'error', (r && (r.error || 'HTTP ' + r.status)) || 'no reply'); return; }
    var text = readReply(r.data);
    push('chat', 'ade', 'text', text || '(no output)');
    if (text && await B.speakEnabled()) speakText(text);
  }
  window.__runVoice = runVoice;

  /* The one place recognised speech becomes an action. The glyph renderer has
     already stripped the wake word and relayed the event; this window decides
     the tab and the beat. A ground ask is sent straight away (asking changes
     nothing -- /v1/ask answers or stages); EVERYTHING else stages in the input
     and waits for a human Enter, `/v1/terminal` and `/v1/tasks` included. */
  function handleSpeech(ev) {
    sayStatus(null);
    if (!ev) return;
    if (ev.status === 'listening' || ev.status === 'recognising') {
      if (B) B.openChat('chat'); setTab('chat');
      sayStatus(ev.status);
      return;
    }
    if (ev.status === 'error') {
      if (B) B.openChat('chat'); setTab('chat');
      push('chat', 'ade', 'error', ev.text || 'Microphone unavailable.');
      return;
    }
    if (ev.empty) {
      if (B) B.openChat('chat'); setTab('chat');
      push('chat', 'system', 'staged', 'Listening.');
      focusInput();
      return;
    }
    var text = String(ev.text == null ? '' : ev.text);
    var engine = String(ev.engine || '');
    var spoken = normalizeSpoken(text);
    if (VOICE_ACTIONS[spoken]) { void runVoice(spoken, engine); return; }   /* stop opens nothing */
    var typed = spokenToTyped(text);
    var c = classify(typed);
    if (c.kind === 'ask' && c.route === 'ground') {
      if (B) B.openChat('chat'); setTab('chat');
      void send(typed);
      return;
    }
    var target = c.kind === 'shell' ? 'shell' : c.kind === 'ask' ? 'chat' : 'task';
    if (B) B.openChat(target);
    setTab(target);
    paintTabLabel();
    var transcript = '“' + text + '”' + (engine && engine !== 'whisper' ? ' · ' + engine : '');
    push(target, 'system', 'staged', transcript);
    input.value = typed;
    focusInput();
    if (c.kind !== 'shell') input.select();
  }
  window.__handleSpeech = handleSpeech;
```

**4. Wire boot()** — add these handlers where the other `B.*` bindings live:

```js
    B.onSpeech(handleSpeech);
    B.onNote(function (m) { push('chat', 'system', 'staged', String(m)); });
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `voiceRelay.ok` true (rewrites, staged shell never dispatches, bare ask → open Chat + one `/v1/ask`, `stop` opens nothing, `pttSmoke.ok` against the real relay), `chatProbe`/`slashChat`/`askChat`/`smsApproval` still true, glyph `mic`/`hearing`/`hit`/`interact`/`keys`/`probe` still true.

- [ ] **Step 5: Commit**

```bash
git add ui.js preload.js main.js chat.js
git commit -m "feat(avatar): voice relays into the chat window; the orb renderer shrinks to mic, wake and speak"
```

---

### Task 6: The orb is a launcher (bar DOM deleted, glyph click opens the window)

**Files:**
- Modify: `avatar.html` (delete the `#bar` block and its CSS)
- Modify: `ui.js` (final shrink: no bar, no hit-state coupling, click → `openChat`)
- Modify: `preload.js` (remove `bar`/`onToggleBar`)
- Modify: `main.js` (glyph window becomes `S x S` — `BAR_H` gone, never focusable; `win:bar` deleted; smoke: rework `interact`/`hit`/`keys`, baseline-hide in `voiceRelay`)
- Test: `--smoke`

**Interfaces:**
- Consumes: Task 2's `openChat`, Task 5's relaying ui.js.
- Produces (end-state): the glyph window never takes the keyboard (`applyHit` always `setFocusable(false)`), single-click on the orb opens/focuses `chatWin`; `win:bar` IPC and the `bar` bridge are deleted; `chatWin` is now the only focusable window. All keyboard input belongs to it.

- [ ] **Step 1: Write the failing smoke reworks**

In `main.js` `startSmokeRun()`:

1. **`interact`** — replace the whole existing block with a launcher probe (fires a real click on the glyph and asserts the chat window opened; the bar is gone):

```js
    let interact = {};
    try {
      interact = JSON.parse(await win.webContents.executeJavaScript(
        '(function(){ var c=document.getElementById("glyph");' +
        ' c.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,screenX:10,screenY:10}));' +
        ' window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,button:0,screenX:10,screenY:10}));' +
        ' return JSON.stringify({ hasPTT: typeof window.PTT, bridge: typeof window.adeBridge,' +
        '   listeners: !!(window.GLYPH && window.GLYPH.setSpeaking),' +
        '   noBar: !document.getElementById("bar") }); })()'
      ));
      await new Promise((r) => setTimeout(r, 250));   /* chat:open round trip */
      interact.chatOpened = !!(chatWin && chatWin.isVisible());
      interact.ok = interact.chatOpened === true
        && interact.noBar === true
        && interact.hasPTT === 'object'
        && interact.bridge === 'object'
        && interact.listeners === true;
    } catch (e) { interact = { error: String((e && e.message) || e) }; }
```

2. **`hit`** — replace the whole block (no bar to open; the glyph is never focusable, and the corners vs glyph mouse handing is unchanged):

```js
    let hit = {};
    try {
      const settle = (ms) => new Promise(r => setTimeout(r, ms || 160));
      const move = (x, y) => win.webContents.executeJavaScript(
        'window.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:' + x + ',clientY:' + y + '})), 0');
      const snap = () => ({ ignoresMouse: lastIgnore, focusable: win.isFocusable() });
      await move(4, 4); await settle();
      hit.overCorner = snap();                /* expect ignoresMouse true  */
      await move(230, 190); await settle();
      hit.overGlyph = snap();                 /* expect ignoresMouse false */
      await move(4, 4); await settle();
      hit.offAgain = snap();                  /* expect ignoresMouse true  */
      hit.glyphNotFocusable = win.isFocusable() === false;
      hit.ok = hit.overCorner.ignoresMouse === true
            && hit.overGlyph.ignoresMouse === false
            && hit.offAgain.ignoresMouse === true
            && hit.glyphNotFocusable === true;
    } catch (e) { hit = { error: String((e && e.message) || e) }; }
```

3. **`keys`** — the hint now lives in the chat window; run the probe there (same contracts, `shortcuts.bar` becomes `shortcuts.chat` in Task 7):

```js
    let keys = {};
    try {
      const kjs = (s) => chatWin.webContents.executeJavaScript(s);
      const shown = await kjs('(document.getElementById("talkKey")||{}).textContent || ""');
      const plain = (t) => t.split('+').map((p) => (p === 'Ctrl' ? 'Control' : p === 'Win' ? 'Super' : p)).join('+');
      const OS_OWNED = ['Alt+Space', 'Super+Space'];
      keys = {
        bound: shortcuts,
        hintShows: shown,
        hintMatchesBinding: shortcuts.talk
          ? (plain(shown) === shortcuts.talk && shown.indexOf('++') < 0)
          : shown === 'tray menu',
        takesNoOsKey: !OS_OWNED.includes(shortcuts.bar) && !OS_OWNED.includes(shortcuts.talk)
      };
      keys.ok = keys.hintMatchesBinding && keys.takesNoOsKey;
    } catch (e) { keys = { error: String((e && e.message) || e) }; }
```

4. **`voiceRelay`** — the launcher click now opens `chatWin` earlier in the run, so baseline it closed before the ask step so `askOpened` still proves the speech path opened it. Add after the recorder is installed (inside the inner `try`, before the rewrites read):

```js
        await js('window.adeBridge.hideChat(),0');
        await new Promise((r) => setTimeout(r, 120));
```

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `interact.ok` false (`noBar` is false while the bar still exists, and clicking still toggles it), `hit` fails (`hit.glyphNotFocusable` false or focus toggling still asserts), `keys` fails against the glyph window (`talkKey` still in the bar there and chatWin's copy is populated but the probe now reads chatWin — actually `keys` may still pass since chat.js populates #talkKey from Task 2; the meaningful failure is `interact`/`hit`).

- [ ] **Step 3a: delete the bar from `avatar.html`** — remove the whole `<div id="bar">…</div>` block (lines 115–132) and the bar-scoped CSS: `#bar`, `#bar.open`, `.row`, `#mode` + task/shell/ask variants, `#mic`, `#in`, `#out`, `#skills`, `#approve`, `.btns`, `button*`, `#bar.dropping`, `.spin`, `#hint`. Keep `:root`, the `html, body` rules, `#glyph`, and the script tags (glyph.js/ptt.js/ui.js).

- [ ] **Step 3b: strip `preload.js`** — delete the two lines:

```js
  bar: (open) => ipcRenderer.send('win:bar', !!open),
```
```js
  onToggleBar: (fn) => ipcRenderer.on('ui:toggleBar', () => fn()),
```

- [ ] **Step 3c: `main.js`** — the glyph becomes a bare orb.

Delete the `BAR_H` constant; `createWindow`:

```js
function createWindow() {
  const S = cfg.size;
  const area = screen.getPrimaryDisplay().workArea;
  let x = cfg.x == null ? area.x + area.width - S - 48 : cfg.x;
  let y = cfg.y == null ? area.y + area.height - S - 48 : cfg.y;
  const fitted = clampToScreen(x, y, S, S);
  if (fitted.x !== x || fitted.y !== y) {
    x = fitted.x; y = fitted.y;
    cfg.x = x; cfg.y = y; saveCfg();
  }

  win = new BrowserWindow({
    width: S, height: S, x, y,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, acceptFirstMouse: true,
    title: 'Ade',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyHit();
  win.setOpacity(cfg.opacity);
  win.loadFile('avatar.html', { query: { avatar: '1', glyph: String(S) } });

  win.on('moved', () => {
    const [nx, ny] = win.getPosition();
    cfg.x = nx; cfg.y = ny; saveCfg();
  });
  win.on('closed', () => { win = null; });
}
```

`applyHit` — no bar, never focusable:

```js
/* The glyph never takes the keyboard: every keypress belongs to the chat
   window or the app behind the transparent bits. The only dynamic is the
   mouse -- handed back anywhere the orb is not painted. */
function applyHit() {
  if (!win || win.isDestroyed()) return;
  const wants = !cfg.clickThrough && overPaint;
  lastIgnore = !wants;
  win.setIgnoreMouseEvents(lastIgnore, { forward: true });
  win.setFocusable(false);
  win.setAlwaysOnTop(true, 'screen-saver');
}
```

The `let overPaint = false, barOpen = false, lastIgnore = null;` declaration loses `barOpen`. Delete the `ipcMain.on('win:bar', ...)` handler block. The Size menu handler `win.setSize(px, px + BAR_H)` becomes `win.setSize(px, px)`.

- [ ] **Step 3d: rewrite `ui.js`** to the full content below (the final glyph renderer):

```js
/* The avatar's orb renderer: drag it, single-click it to open the desktop
 * conversation window. The command surface lives in the chat window (chat.js);
 * THIS window owns only
 *   - drag / single-click / click-through hit logic
 *   - the live microphone, push-to-talk, and the wake gate   (ptt.js)
 *   - Ade's spoken replies: the ONE audio engine, and the glyph's mouth
 * and RELAYS recognised speech to the chat window through main.
 */
'use strict';
(function () {
  var B = window.adeBridge;
  var cvs = document.getElementById('glyph');

  /* -------------------------------------------------------------- speech */
  var actx = null, speakSrc = null, speakAn = null, speakRaf = 0, speakBuf = null;

  function stopSpeaking() {
    if (speakRaf) { cancelAnimationFrame(speakRaf); speakRaf = 0; }
    if (speakSrc) { try { speakSrc.onended = null; speakSrc.stop(); } catch (e) {} speakSrc = null; }
    speakAn = null;
    if (window.GLYPH) window.GLYPH.setSpeaking(0);
  }

  async function speakText(text) {
    if (!B || !text) return;
    var r = await B.speak(text);
    if (!r || !r.ok) return;
    stopSpeaking();
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') await actx.resume();
      var raw = atob(r.wav), n = raw.length, bytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) bytes[i] = raw.charCodeAt(i);
      var buf = await actx.decodeAudioData(bytes.buffer);
      var src = actx.createBufferSource(); src.buffer = buf;
      var an = actx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.55;
      src.connect(an); an.connect(actx.destination);
      speakSrc = src; speakAn = an; speakBuf = new Uint8Array(an.fftSize);
      src.onended = stopSpeaking;
      src.start();
      (function tick() {
        if (!speakAn) return;
        speakAn.getByteTimeDomainData(speakBuf);
        var sum = 0;
        for (var j = 0; j < speakBuf.length; j++) { var v = (speakBuf[j] - 128) / 128; sum += v * v; }
        var lvl = Math.min(1, Math.sqrt(sum / speakBuf.length) * 4.6);
        if (window.GLYPH) window.GLYPH.setSpeaking(lvl);
        speakRaf = requestAnimationFrame(tick);
      })();
    } catch (e) { stopSpeaking(); }
  }

  /* ------------------------------------------------------------ sizing */
  function sizeCanvas() {
    var p = new URLSearchParams(location.search);
    var s = parseInt(p.get('glyph') || '380', 10);
    cvs.style.width = window.innerWidth + 'px';
    cvs.style.height = s + 'px';
    window.dispatchEvent(new Event('resize'));
  }
  sizeCanvas();
  if (B) B.onSize(function () { setTimeout(sizeCanvas, 30); });
  window.addEventListener('resize', function () { /* glyph.js handles its own */ });

  /* -------------------------------------------------------- drag / click */
  var down = null;
  cvs.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    down = { x: e.screenX, y: e.screenY, moved: 0 };
    if (B) B.dragStart();
    e.preventDefault();
  });
  /* A click (no drag) makes the orb the launcher: it opens the chat window. */
  window.addEventListener('mouseup', function () {
    if (!down) return;
    var wasClick = down.moved <= 3;
    down = null;
    if (B) B.dragEnd();
    if (wasClick && B) B.openChat();
  });
  /* ------------------------------------------------------------ hit area */
  /* The window is a rectangle; the orb is not. Only about a third of it is
     ever painted, and the transparent remainder used to swallow every click
     meant for the window underneath. Report what is actually under the cursor
     and let main.js hand the rest back. */
  var HIT_ALPHA = 48;
  var HIT_PAD = 5;
  var hitOn = null, hitAt = 0;
  var probe = cvs.getContext('2d');

  function painted(px, py) {
    var cw = cvs.clientWidth, ch = cvs.clientHeight;
    if (!(cw > 0 && ch > 0) || px < 0 || py < 0 || px >= cw || py >= ch) return false;
    var d = cvs.width / cw, n = HIT_PAD * 2 + 1;
    var x = Math.max(0, Math.min(cvs.width - n, Math.round(px * d) - HIT_PAD));
    var y = Math.max(0, Math.min(cvs.height - n, Math.round(py * d) - HIT_PAD));
    var data;
    try { data = probe.getImageData(x, y, n, n).data; }
    catch (e) { return true; }
    for (var i = 3; i < data.length; i += 4) if (data[i] >= HIT_ALPHA) return true;
    return false;
  }
  function setHit(on) { if (on !== hitOn) { hitOn = on; if (B) B.hit(on); } }

  window.addEventListener('mousemove', function (e) {
    if (down) {
      setHit(true);
      down.moved = Math.max(down.moved, Math.abs(e.screenX - down.x) + Math.abs(e.screenY - down.y));
      if (down.moved > 3 && B) B.dragMove();
      return;
    }
    var now = Date.now();
    if (now - hitAt < 16) return;
    hitAt = now;
    setHit(painted(e.clientX, e.clientY));
  });
  document.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget && !down) setHit(false);
  });
  cvs.addEventListener('contextmenu', function (e) { e.preventDefault(); if (B) B.menu(); });

  /* ------------------------------------------------------- voice control */
  /* The microphone and the wake gate stay here; the UI they produce lives in
     the chat window. Speech is RELAYED as an event and chat.js decides what to
     do with it -- it never dispatches on recognition alone. */
  var WAKE = /^\s*(?:hey\s+|ok\s+)?ad[ae]y?\s*[,.!?:-]?\s+/i;

  function stripWake(text) {
    var m = String(text == null ? '' : text).match(WAKE);
    return m ? String(text).slice(m[0].length).trim() : null;
  }
  window.__stripWake = stripWake;    /* --smoke reaches it here */

  function onUtterance(u) {
    if (!u || !u.text) return;
    var command = stripWake(u.text);
    if (command === null) return;                  /* not for us: discard */
    if (window.GLYPH && window.GLYPH.wake) window.GLYPH.wake();
    if (B) B.saySpeech({ text: command, engine: u.engine || '', empty: !command });
  }
  window.__onUtterance = onUtterance;

  async function pttDown() {
    if (!B || PTT.isActive()) return;
    var ok = await PTT.start(function (lvl) { if (window.GLYPH) window.GLYPH.setHearing(lvl); });
    if (!ok) { if (B) B.saySpeech({ status: 'error', text: 'Microphone unavailable.' }); return; }
    if (B) B.saySpeech({ status: 'listening' });
  }
  async function pttUp() {
    if (!B || !PTT.isActive()) return;
    if (window.GLYPH) window.GLYPH.setHearing(0);
    if (B) B.saySpeech({ status: 'recognising' });
    var r = await PTT.stop();
    if (!r.ok) { if (B) B.saySpeech({ status: 'error', text: 'Did not catch that (' + r.error + ').' }); return; }
    if (!r.text) { if (B) B.saySpeech({ empty: true, text: '' }); return; }
    if (B) B.saySpeech({ text: r.text, engine: r.engine || '' });
  }
  window.__pttUp = pttUp;

  /* ------------------------------------------------------ Ade's state in */
  if (B) {
    B.onState(function (s) { if (window.GLYPH) window.GLYPH.setAde(s); });
    B.onArm(function () { if (window.GLYPH) window.GLYPH.arm(); });
    B.onSpeak(function (t) { speakText(t); });
    B.onHush(function () { stopSpeaking(); });
    B.onPttDown(function () { pttDown(); });
    B.onPttUp(function () { pttUp(); });
    B.onBacking(function (on) { if (window.GLYPH) window.GLYPH.setBacking(on); });

    /* ------------------------------------------------ the live mic */
    function setMicUi() {
      var live = window.PTT && window.PTT.isLive && window.PTT.isLive();
      if (window.GLYPH && window.GLYPH.setMic) window.GLYPH.setMic(live ? 1 : 0);
      if (B) B.micState(!!live);
    }
    window.__setMicUi = setMicUi;

    async function micOn() {
      var ok = await window.PTT.live(onUtterance, function (lvl) {
        if (window.GLYPH) window.GLYPH.setHearing(lvl);
      });
      if (!ok) { if (B) B.saySpeech({ status: 'error', text: 'Could not open the microphone.' }); }
      setMicUi();
      return ok;
    }
    function micOff() { window.PTT.mute(); if (window.GLYPH) window.GLYPH.setHearing(0); setMicUi(); }
    async function micToggle() { if (window.PTT.isLive()) micOff(); else await micOn(); }
    window.__micToggle = micToggle;
    B.onMicToggle(function () { void micToggle(); });

    B.config().then(function (c) {
      if (c && c.mic !== false) { void micOn(); } else { setMicUi(); }
      if (c && window.GLYPH) window.GLYPH.setBacking(c.backing !== false);
    });
    B.state().then(function (s) { if (s && window.GLYPH) window.GLYPH.setAde(s); });
  }
})();
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `interact.ok` (no bar, click opens `chatWin`), `hit.ok` (corners clear, glyph grabs, never focusable), `keys.ok` (hint in the window names the real `talk` binding, no OS key taken), `voiceRelay.ok`, `chatProbe`/`slashChat`/`askChat`/`smsApproval` all still true, and `probe` reports `bar: false`.

- [ ] **Step 5: Commit**

```bash
git add avatar.html ui.js preload.js main.js
git commit -m "feat(avatar): the orb is a launcher -- bar DOM deleted, single click opens the chat window"
```

---

### Task 7: Hotkey and tray speak the new world; the README agrees

**Files:**
- Modify: `main.js` (`shortcuts.bar` → `shortcuts.chat` with toggle; tray click + menu item; smoke `keys` rework)
- Modify: `README.md` (command-bar sections rewritten for the window)
- Test: `--smoke`

**Interfaces:**
- Consumes: Task 2's `openChat`, Task 6's focusable=false glyph.
- Produces: hotkey **`chat`** (same fallback list) opens/focuses `chatWin`, or hides it when it already has focus; the tray's first item is **"Chat window"** carrying that accelerator and a plain left-click/`click` that opens the window; the `bar` name is gone from `shortcuts`, the tray, the smoke summary, and the README.

- [ ] **Step 1: Write the failing smoke rework**

In `main.js` `startSmokeRun()`, in the `keys` block added in Task 6, change the `OS_OWNED` check so it guards the renamed hotkey and reports the binding:

```js
        takesNoOsKey: !OS_OWNED.includes(shortcuts.chat) && !OS_OWNED.includes(shortcuts.talk),
        chatHotkey: shortcuts.chat,
```

(`hintMatchesBinding` still speaks for `talk`; the `chat` hotkey opens the window from anywhere, which a headless smoke cannot press.) `keys.ok` is unchanged: hint matches the real `talk` binding and no OS key is held.

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `keys.takesNoOsKey` is `undefined` (the block references `shortcuts.chat` before Task 7 exists, so `keys.ok` is false).

- [ ] **Step 3a: `main.js`** — rename the hotkey and its effects.

1. `const shortcuts = { bar: null, talk: null };` → `const shortcuts = { chat: null, talk: null };`
2. In `whenReady().then(...)`, replace the `['bar', ...]` wanted entry:
```js
      ['chat', ['Control+Alt+A', 'Control+Shift+A', 'Control+Alt+G'], () => {
        /* open/focus, or hide when it already has focus -- the bar's old
           toggle behaviour, moved to a window that can be hidden. */
        if (chatWin && chatWin.isVisible() && chatWin.isFocused()) chatWin.hide();
        else openChat();
      }],
```
3. In `buildMenu()`, remove the plain `{ label: 'Chat window', click: () => openChat() },` (added in Task 2 `4h`) and replace the `'Command bar'` item with:
```js
    { label: 'Chat window' + (shortcuts.chat ? '' : '  (no hotkey available)'), accelerator: shortcuts.chat || undefined, click: () => openChat() },
```
4. `createTray()` click — the bar is gone; left-click opens the window:
```js
  tray.on('click', () => openChat());
```

- [ ] **Step 3b: rewrite `README.md`** — the command bar has become the chat window. The affected passages, exactly:

1. In **Using it**, replace the whole table:

```markdown
| | |
|---|---|
| **Drag** the glyph | move it anywhere, on any monitor; position is remembered |
| **Click** the glyph, **Ctrl+Alt+A**, or the tray's *Chat window* | open the desktop conversation window |
| **Right-click** the glyph, or the tray icon | menu: chat window, size, opacity, click-through, backing glow, restart Ade, quit |
| **Esc** | hide the conversation window (the orb and the tray keep the app alive) |

Clicking the orb is now the launcher: a single click opens the window with the
input focused. The orb itself never steals the keyboard — every keypress
belongs to the conversation window or to whatever is underneath the transparent
bits.
```

2. Replace the chip table and the bare-text paragraph with tabs:

```markdown
The window has three tabs, and the labelless input row inherits the active
tab's default. The prefixes still override at every turn:

| You type (or the tab you are in) | Where it goes |
|---|---|
| Chat tab: `what is in glyph.js` | `POST /v1/ask` — a grounded read against the three machine-access roots; the reply names which root it read |
| Chat tab: `fix the failing test in test_gate.py` | `POST /v1/ask` decides this is a change, does nothing, and stages `/coding fix the failing test in test_gate.py` in the **Task tab** — **nothing runs until you press Enter** |
| Task tab, or `/qa run the trust-level suite` | `POST /v1/tasks` — an agent does the work, with an explicit task type |
| Shell tab, or `!git status` | `POST /v1/terminal` — direct subprocess |
| `?what brain are you on` | `POST /v1/chat/completions` — plain chat, no roots read |

Bare text used to dispatch a coding Task the instant you pressed Enter. It asks
now: `/v1/ask` either answers directly or — for anything that looks like a
change — does nothing and hands back what it would run, which lands in the Task
tab as a staged `/<type> <prompt>` for you to read before it does anything.
Every thread persists across restarts (`userData/threads.json`).
```

3. In **Voice**:
   - "The button in the command bar, the tray item, and the talk hotkey" → "The **Mute** button in the chat window, the tray item, and the talk hotkey".
   - "`read the file` | opens the command bar primed for you to finish typing" → "opens the chat window primed for you to finish typing".
   - "`open the command bar / stop` | drives the avatar itself" → "**open the command window** opens the chat window; **stop** cuts off speech and opens nothing".
   - "lands in the bar for you to review and press Enter" → "opens the matching tab and stages it in the window's input for you to review and press Enter".
   - "which still lands in the bar as a staged `/<type> <prompt>` for your own Enter" → "which stages in the Task tab as a `/<type> <prompt>` for your own Enter".
   - "the spoken text in the command bar's reply is suffixed ` · windows`" → "the spoken transcript in the window is suffixed ` · windows`".

4. In **What the glyph is telling you**, the last table row: "turns **amber**, throws arcs, and the command bar opens with Allow / Deny" → "turns **amber**, throws arcs, and the chat window raises with the approval card in its Task tab".

5. In **The two kinds of power behind one input**: "The Shell chip turns amber and the hint line reads *"NOT gated by Permission.check()"* whenever you type `!`." → "The Shell tab is labelled *"NOT gated by Permission.check()"* permanently — typing into it is always a direct subprocess."

6. In **It must not capture what it is not covering**: replace "Focus follows the same rule — only the command bar has any use for the keyboard, so only the command bar may take the foreground, and closing it gives the keyboard back." with "Focus follows the same rule — the glyph is **never** keyboard-focusable, so a click on it can neither trap keystrokes nor steal the foreground from the window underneath; all typing goes to the conversation window."

7. In **Self-check**, extend the last paragraph: "…prints what Ade looks like from here, and exits." plus:

```markdown
The same run asserts the conversation window: it exists framed and resizable,
stays hidden until opened, draws the Chat / Shell / Task tabs, round-trips its
threads through a temp file, stages escalations without dispatching, drives
approval cards, and relays recognized speech without ever dispatching on
recognition alone. The pure thread-store module has its own unit tests:
`node --test tests/threads-store.test.js`.
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `keys.ok` true again (`takesNoOsKey` guards `shortcuts.chat`, summary prints `chatHotkey` with the bound combo), everything else unchanged/true.

- [ ] **Step 5: Commit**

```bash
git add main.js README.md
git commit -m "feat(avatar): the bar hotkey becomes the chat window hotkey; tray and README agree"
```

---

### Task 8: Drop files onto the chat window (upload by drag-and-drop)

**Files:**
- Modify: `chat.js` (`dragover`/`dragleave`/`drop` handlers + `__dropPaths` seam)
- Modify: `main.js` (`startSmokeRun`: new `dropChat` probe)
- Modify: `README.md` (one sentence in the upload/tabs passage)
- Test: `--smoke`

**Interfaces:**
- Consumes: Task 2's preload `B.dropPaths(files)` (already wedged — the page CSP forbids network, **Electron 32 removed `File.path`**, so `webUtils.getPathForFile` runs in preload and only the string list crosses back), Task 2's `busy`/`activeTab`, Task 3's `doUpload(paths, overwrite)` and `push`.
- Produces: on every drop the overlay toggles `document.body`'s `dropping` class (CSS already delivered in Task 2's chat.html) and the paths go to `doUpload`; a dropless drop (JS-made files) names the `/upload` fallback instead of dying silently.
- The glyph window gets **no** drop path — it is click-through wherever it is not painted, so an OS drag there lands on whatever is underneath; the chat window is opaque and framed, so the drop always arrives.

- [ ] **Step 1: Write the failing smoke probe**

In `startSmokeRun()`, add a `dropChat` probe after the `smsApproval` block. It shows the window, drives a synthetic `dragover`/`drop` with a JS-constructed `File` (which `webUtils` rejects — no backing file — so the drop lands the "Nothing droppable" error, proving the whole handler→bridge→push chain ran without a real OS drag):

```js
      let dropChat = {};
      try {
        await js('window.adeBridge.openChat(),0');
        await new Promise((r) => setTimeout(r, 160));   /* chat:open round trip */
        await js('(function(){ var dt = new DataTransfer();' +
                 ' dt.items.add(new File(["x"], "fake.txt"));' +
                 ' window.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));' +
                 ' void 0; })()');
        await new Promise((r) => setTimeout(r, 40));
        dropChat.overlayOn = await js('document.body.classList.contains("dropping")');
        await js('(function(){ var dt = new DataTransfer();' +
                 ' dt.items.add(new File(["x"], "fake.txt"));' +
                 ' window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));' +
                 ' void 0; })()');
        await new Promise((r) => setTimeout(r, 120));
        dropChat.overlayOff = !(await js('document.body.classList.contains("dropping")'));
        dropChat.nothingSelected = (await js('document.getElementById("thread").textContent'))
          .indexOf('Nothing droppable there.') >= 0;
        dropChat.ok = dropChat.overlayOn === true
          && dropChat.overlayOff === true
          && dropChat.nothingSelected === true;
      } finally {
        await js('window.adeBridge.hideChat(),0').catch(() => {});
        await js('(function(){ var w = window.__threads();' +
                 ' for (var t in w) w[t] = (w[t] || []).filter(function(m){' +
                 ' return m.text !== "Nothing droppable there. Use /upload to pick files, or /upload folder for a directory."' +
                 ' && m.text !== "…uploading"; });' +
                 ' window.adeBridge.threadsSave(w),0; })(),0').catch(() => {});
      }
    } catch (e) { dropChat = { error: String((e && e.message) || e) }; }
```

Add `dropChat,` to the SMOKE summary object after the `smsApproval,` line.

- [ ] **Step 2: Run smoke to verify it fails**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: FAIL — `dropChat.overlayOn` stays `false` (no chat.js `dragover` handler sets `dropping`).

- [ ] **Step 3: Implement drop in `chat.js`**

Insert a new section inside the closure, right after Task 3's upload section (after `window.__handleUpload = handleUpload;`):

```js
  /* ------------------------------------------------------- drag and drop */
  /* The chat window is opaque and framed, so an OS drag always lands HERE --
     the glyph is click-through wherever it is not painted, so `/upload` in
     the window and the native picker are the only reliable paths there.
     A dropped path still comes from webUtils in the preload (`B.dropPaths`);
     Electron 32 removed `File.path`, so the page cannot learn a path by
     itself, and nothing leafs the bridge but strings. */
  window.addEventListener('dragover', function (e) {
    e.preventDefault();               /* never let the page navigate to a drop */
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dropping');
  });
  window.addEventListener('dragleave', function () {
    document.body.classList.remove('dropping');
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    document.body.classList.remove('dropping');
    if (busy || !B) return;
    var paths = B.dropPaths(e.dataTransfer && e.dataTransfer.files);
    if (!paths.length) {
      push(activeTab, 'ade', 'error',
        'Nothing droppable there. Use /upload to pick files, or /upload folder for a directory.');
      return;
    }
    void doUpload(paths, false);
  });
  window.__dropPaths = function (files) { return B ? B.dropPaths(files) : []; };
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Expected: PASS — `dropChat.ok` true (overlay on over a drag, off after the drop, "Nothing droppable there." reported for a pathless File), everything else unchanged/true.

- [ ] **Step 5: README one-liner**

In the tabs table that Task 7 rewrote (upload passage), after the `/upload` mention add: "**Drop files or folders straight onto the window** in any tab — same walk, same report."

- [ ] **Step 6: Commit**

```bash
git add chat.js main.js README.md
git commit -m "feat(avatar): drop files onto the chat window"
```

---

### Task 9: Verification pass (no new features) and a real-human checklist

**Files:** none (cleanups only if a step finds a stray).
**Test:** full `--smoke`, `node --test tests/threads-store.test.js`, then a hands-on pass with the glyph on a live Ade OS.

**Interfaces:** nothing new — this task proves Tasks 1–8 hold together and deletes anything they left dangling.

- [ ] **Step 1: Pure-module test**

Run: `node --test tests/threads-store.test.js` (Node v24 for `node:test`)
Expected: 5/5 pass — corrupt `.bak` recovery, `MAX_MESSAGES` trim, name-sorting, async-backed `load`, debounced save.

- [ ] **Step 2: Full smoke with the summary read, not skimmed**

Run: `& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000`
Read the printed probe table and confirm each `ok: true`: `hit` (glyph click-through), `voice` (stripWake/relay taxonomy), `mic` (track counts), `hearing`, `keys` (chat hotkey not an OS key, hint matches binding), `chatProbe` (window exists/hidden/resizable/taskbar/threads round-trip), `slashChat`, `askChat` (`__dispatchCount` still 0), `smsApproval`, `dropChat`, `voiceRelay`, `pttSmoke`. Any `error:` line means the task that owns it regressed — go fix that task, not this one.

- [ ] **Step 3: Dead-reference audit**

The bar must leave no trace. Grep and confirm ZERO hits in `main.js`, `preload.js`, `ui.js`, `chat.js`, `README.md`:

```
ui:toggleBar      shortcuts.bar     win:bar          BAR_H
toggleBar         talkKey           id="bar"         id="mic"
id="in"           bar.classList      id="out"         '#bar'
```

(`grep` each one; a single hit is a leak — e.g. the tray `click` still sending `ui:toggleBar`, or a README sentence still teaching "the command bar".) Fix any hit and re-run Step 2.

- [ ] **Step 4: Hands-on pass (the machine, with Ade OS live)**

Use `.\run-avatar.ps1` and go through every row; anything that fails here is a plan miss, fix it and re-run the smoke:

1. Click the orb → the chat window opens focused, input ready; no focus steal on the glyph itself.
2. `Ctrl+Alt+A` toggles the window (open → focused Escape hides → hotkey reopens to the same tab).
3. Tray: first item is "Chat window" naming the bound hotkey; left-click opens; the old "Command bar"/toggle entries are gone.
4. Chat tab: type a question → grounded answer, root named; type a change → it stages in the Task tab, nothing runs.
5. Shell tab: label reads "NOT gated by Permission.check()"; `!hostname` runs; **no** "command bar" anywhere it was taught to you.
6. Task tab: `/qa …` dispatches; the approval card arrives, the window RAISES (amber orb), Allow/Deny works, decides persists across restart.
7. Mic: the window's Mute mirrors the tray/talk hotkey and the OS indicator goes out.
8. Voice: say "Ade, run the tests" → the window opens and the staged task appears; say "Ade, stop" → speech cuts with NO window; a mis-recognized phrase never dispatches.
9. Drag a file and a folder onto the open window → both upload with the report in messages; the dashed overlay shows while dragging.
10. `/skill` attach and `/upload` picker both work from any tab; kill and relaunch → threads, skills, decisions all survive.
11. `Esc` hides from every tab; the window is gone from nowhere it should be — `Alt+Tab` shows it, the translucent orb window is not in the taskbar.

- [ ] **Step 5: Commit any cleanups, then close the loop**

```bash
git add -A -- ':(exclude)docs/superpowers/plans'
git commit -m "chore(avatar): end-to-end verification of the chat window migration"
```

(If Step 4 found nothing, amend into the last task's commit instead; never leave the repo with an empty "verification" commit.)

---

---

---

---

---
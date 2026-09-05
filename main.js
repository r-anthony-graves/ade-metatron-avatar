/* Ade OS desktop avatar -- a transparent, always-on-top Metatron glyph.
 *
 * It is a CLIENT to Ade OS on 127.0.0.1:8300, deliberately. This process never
 * spawns a shell of its own -- a second execution path beside the gate is what
 * adeos/permission/gate.py's assert_no_bypass() exists to catch, and it would
 * make the gate decorative.
 *
 * The two routes it uses are NOT equally governed, and the UI says so:
 *   /v1/tasks     an agent performs the work, so Permission.check() applies,
 *                 the trust tiers apply, and the call lands in the audit log.
 *   /v1/terminal  a direct subprocess. Ade OS treats this route as Ray's own
 *                 keyboard and does not consult the gate at all. The avatar
 *                 surfaces that path rather than inventing one, and labels it
 *                 "ungated" at the point of use.
 */
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadThreads, saveThreads } = require('./threads-store');

const ADE_BASE = process.env.ADEOS_URL || 'http://127.0.0.1:8300';
const SMOKE = process.argv.includes('--smoke');
const BAR_H = 108;                       /* the command bar lives under the glyph */
const CFG_PATH = () => path.join(app.getPath('userData'), 'avatar-state.json');

let win = null, tray = null, timer = null, dragAnchor = null;
let chatWin = null;                 /* the desktop conversation window */
let overPaint = false, barOpen = false, lastIgnore = null;
let cfg = { x: null, y: null, size: 380, clickThrough: false, speak: false, opacity: 1, backing: true, mic: true,
            chatX: null, chatY: null, chatW: 900, chatH: 620 };
let micLive = false;   /* what the renderer last reported, for the tray label */
let state = { online: false, busy: false, pending: 0, brain: '', approval: null };

function loadCfg() {
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_PATH(), 'utf8'))); } catch (e) {}
}
function saveCfg() {
  if (SMOKE) return;                     /* a self-test must not rewrite real settings */
  try {
    fs.mkdirSync(path.dirname(CFG_PATH()), { recursive: true });
    fs.writeFileSync(CFG_PATH(), JSON.stringify(cfg, null, 2));
  } catch (e) {}
}

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

/* ---------------------------------------------------------------- Ade OS */
async function ade(pathname, { method = 'GET', body = null, timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(ADE_BASE + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(kill);
  }
}

/* /v1/voice/speak answers with audio/wav. ade() reads text() and would mangle
   it, so speech takes its own path and hands the renderer base64 to decode. */
async function adeSpeak(text) {
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(ADE_BASE + '/v1/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '').slice(0, 600) }),
      signal: ctl.signal
    });
    if (!res.ok) return { ok: false, status: res.status, error: 'speak returned ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, status: res.status, error: 'empty audio' };
    return { ok: true, wav: buf.toString('base64') };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(kill);
  }
}

/* ---------------------------------------------------------------- upload */
/* Ray, 2026-08-28: "the ability to upload files and folder".
 *
 * The WALK happens here, in main, not in the renderer. Two reasons, both from
 * the code rather than preference: the page's CSP is `default-src 'none'`, so
 * the renderer cannot reach the network at all; and Electron 33 removed
 * `File.path`, so the renderer cannot even learn what was dropped without
 * `webUtils.getPathForFile` through the preload. Main gets real paths, walks
 * directories itself, and POSTs one file per request -- which keeps the
 * server's streaming-with-abort property, so an oversized file never lands.
 *
 * Every limit REPORTS rather than truncating silently. A drop that quietly
 * sent half a folder is the same class of failure as a skill that quietly
 * arrives at half its length. */
const UPLOAD_MAX_FILES = 500;
const UPLOAD_MAX_TOTAL = 50 * 1024 * 1024;
const UPLOAD_MAX_DEPTH = 16;
const UPLOAD_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

function walkUpload(root, out, skipped) {
  /* `root` is the dropped path. Names are kept RELATIVE TO ITS PARENT so the
     dropped folder keeps its own name on the far side -- dropping `myproj`
     gives `myproj/src/a.py`, not a loose `src/a.py`. */
  const base = path.dirname(root);
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try { st = fs.statSync(current); }
    catch (e) { skipped.push({ path: current, why: String((e && e.code) || e) }); continue; }
    const rel = path.relative(base, current).split(path.sep).join('/');
    if (st.isDirectory()) {
      if (UPLOAD_SKIP_DIRS.has(path.basename(current))) {
        skipped.push({ path: rel, why: 'skipped by name' });
        continue;
      }
      if (rel.split('/').length >= UPLOAD_MAX_DEPTH) {
        skipped.push({ path: rel, why: 'deeper than ' + UPLOAD_MAX_DEPTH });
        continue;
      }
      let names = [];
      try { names = fs.readdirSync(current); }
      catch (e) { skipped.push({ path: rel, why: String((e && e.code) || e) }); continue; }
      for (const n of names) stack.push(path.join(current, n));
      continue;
    }
    if (!st.isFile()) { skipped.push({ path: rel, why: 'not a regular file' }); continue; }
    out.push({ full: current, rel, bytes: st.size });
  }
}

async function adeUpload(paths, overwrite) {
  const wanted = [], skipped = [];
  for (const p of (paths || [])) {
    if (typeof p === 'string' && p) walkUpload(p, wanted, skipped);
  }
  wanted.sort((a, b) => a.rel.localeCompare(b.rel));

  /* Trim to the caps BEFORE sending anything, so the report is accurate
     rather than discovered halfway through. */
  const send = [];
  let total = 0;
  for (const f of wanted) {
    if (send.length >= UPLOAD_MAX_FILES) { skipped.push({ path: f.rel, why: 'over ' + UPLOAD_MAX_FILES + ' files' }); continue; }
    if (total + f.bytes > UPLOAD_MAX_TOTAL) { skipped.push({ path: f.rel, why: 'over the 50 MB drop limit' }); continue; }
    send.push(f); total += f.bytes;
  }

  let sent = 0, bytes = 0;
  const failed = [];
  for (const f of send) {
    let body;
    try {
      body = new FormData();
      body.append('file', new Blob([fs.readFileSync(f.full)]), path.basename(f.rel));
      body.append('relpath', f.rel);
      body.append('overwrite', overwrite ? 'true' : 'false');
    } catch (e) { failed.push({ path: f.rel, why: String((e && e.message) || e) }); continue; }
    try {
      const res = await fetch(ADE_BASE + '/v1/upload', { method: 'POST', body });
      const text = await res.text();
      if (!res.ok) {
        let why = 'HTTP ' + res.status;
        try { why = JSON.parse(text).error.message || why; } catch (e) { /* keep */ }
        failed.push({ path: f.rel, why });
        continue;
      }
      sent += 1; bytes += f.bytes;
    } catch (e) { failed.push({ path: f.rel, why: String((e && e.message) || e) }); }
  }
  return { sent, bytes, found: wanted.length, skipped, failed };
}
ipcMain.handle('ade:upload', (_e, paths, overwrite) => adeUpload(paths, overwrite));
ipcMain.handle('ade:pick', async (_e, wantFolder) => {
  const r = await dialog.showOpenDialog(win, {
    title: wantFolder ? 'Upload a folder' : 'Upload files',
    properties: wantFolder
      ? ['openDirectory', 'multiSelections']
      : ['openFile', 'multiSelections']
  });
  return (r && !r.canceled && r.filePaths) ? r.filePaths : [];
});

let voiceList = [];
async function loadVoices() {
  const r = await ade('/v1/voice/voices', { timeout: 5000 });
  if (r.ok && r.data && Array.isArray(r.data.voices)) voiceList = r.data.voices;
  return voiceList;
}
async function currentVoice() {
  const r = await ade('/v1/settings/appearance', { timeout: 5000 });
  return (r.ok && r.data && r.data.values && r.data.values.tts_voice) || '';
}

async function pollAde() {
  const h = await ade('/v1/health', { timeout: 4000 });
  const online = !!(h.ok && h.data && h.data.status === 'up');
  let busy = false, pending = 0, brain = '', approval = null;

  if (online) {
    const sub = (h.data.subsystems || {}).inference || {};
    brain = sub.detail || '';
    const [act, apr] = await Promise.all([
      ade('/v1/activity', { timeout: 4000 }),
      ade('/v1/approvals', { timeout: 4000 })
    ]);
    if (act.ok && act.data) busy = !!act.data.active || (act.data.count | 0) > 0;
    if (apr.ok && apr.data && Array.isArray(apr.data.approvals)) {
      const open = apr.data.approvals.filter(a => !a.decided);
      pending = open.length;
      if (open.length) {
        const a = open[0];
        approval = { id: a.id, tool: a.tool, args: a.args || {} };
      }
    }
  }
  state = { online, busy, pending, brain, approval };
  if (win && !win.isDestroyed()) win.webContents.send('ade:state', state);
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('ade:state', state);
  if (tray) {
    tray.setToolTip(online
      ? `Ade OS — ${pending ? pending + ' awaiting approval' : (busy ? 'working' : 'idle')}\n${brain}`
      : 'Ade OS — offline');
  }
}

/* ------------------------------------------------------------- hit area */
/* Windows gives a transparent window a RECTANGULAR hit region, so all
   460x568 of it swallow the mouse -- but only about a third of that
   rectangle is ever painted. Sitting over another window, the invisible
   remainder eats its clicks, and the app underneath looks frozen.

   Focus is the same mistake twice: nothing here ever handed the foreground
   back, so one click on the glyph left keystrokes going into a frameless,
   taskbar-less window with nothing focused in it. Only the command bar has
   any use for the keyboard, so only the command bar may take the foreground. */
function applyHit() {
  if (!win || win.isDestroyed()) return;
  const wants = !cfg.clickThrough && (overPaint || barOpen);
  lastIgnore = !wants;
  win.setIgnoreMouseEvents(lastIgnore, { forward: true });
  win.setFocusable(barOpen);
  win.setAlwaysOnTop(true, 'screen-saver');   /* setFocusable rebuilds the styles */
}

/* ---------------------------------------------------------------- window */
function clampToScreen(x, y, w, h) {
  /* A saved position survives a monitor change that invalidates it, and an
     off-screen window is indistinguishable from a broken one. Keep at least a
     corner of it reachable on whichever display is nearest. */
  const near = screen.getDisplayMatching({ x, y, width: w, height: h }) || screen.getPrimaryDisplay();
  const a = near.workArea;
  const MARGIN = 60;                     /* how much must stay grabbable */
  return {
    x: Math.round(Math.min(Math.max(x, a.x - (w - MARGIN)), a.x + a.width - MARGIN)),
    y: Math.round(Math.min(Math.max(y, a.y), a.y + a.height - MARGIN))
  };
}

function createWindow() {
  const S = cfg.size;
  const area = screen.getPrimaryDisplay().workArea;
  let x = cfg.x == null ? area.x + area.width - S - 48 : cfg.x;
  let y = cfg.y == null ? area.y + area.height - (S + BAR_H) - 48 : cfg.y;
  const fitted = clampToScreen(x, y, S, S + BAR_H);
  if (fitted.x !== x || fitted.y !== y) {
    x = fitted.x; y = fitted.y;
    cfg.x = x; cfg.y = y; saveCfg();     /* remember the corrected spot, not the lost one */
  }

  win = new BrowserWindow({
    width: S, height: S + BAR_H, x, y,
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
    flushThreads();
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

/* ------------------------------------------------------------------ tray */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: state.online ? `Ade OS: ${state.pending ? state.pending + ' awaiting approval' : (state.busy ? 'working' : 'idle')}` : 'Ade OS: offline', enabled: false },
    { label: state.brain ? '  ' + state.brain : '  (no brain reported)', enabled: false },
    { type: 'separator' },
    { label: 'Chat window', click: () => openChat() },
    { label: 'Command bar' + (shortcuts.bar ? '' : '  (no hotkey available)'), accelerator: shortcuts.bar || undefined, click: () => win && win.webContents.send('ui:toggleBar') },
    { label: (pttOn ? 'Stop listening' : 'Speak a command') + (shortcuts.talk ? '' : '  (no hotkey available)'), accelerator: shortcuts.talk || undefined, click: togglePtt },
    {
      label: micLive ? 'Mute the microphone' : 'Unmute the microphone',
      accelerator: shortcuts.talk || undefined,
      click: () => win && win.webContents.send('ui:micToggle')
    },
    { label: micLive ? '  microphone is OPEN' : '  microphone track is stopped', enabled: false },
    { label: 'Mic drives the glyph', type: 'checkbox', checked: false, click: () => win && win.webContents.send('ui:arm') },
    { type: 'separator' },
    {
      label: 'Click-through', type: 'checkbox', checked: !!cfg.clickThrough,
      click: (mi) => {
        cfg.clickThrough = mi.checked; saveCfg();
        applyHit();
      }
    },
    { label: 'Speak Ade’s replies', type: 'checkbox', checked: !!cfg.speak, click: (mi) => { cfg.speak = mi.checked; saveCfg(); } },
    {
      label: 'Backing glow', type: 'checkbox', checked: cfg.backing !== false,
      toolTip: 'A soft dark halo so the glyph reads on a pale wallpaper. Off is pure transparency.',
      click: (mi) => { cfg.backing = mi.checked; saveCfg(); if (win) win.webContents.send('ui:backing', mi.checked); }
    },
    {
      label: 'Size', submenu: [280, 340, 380, 460, 560].map(px => ({
        label: px + ' px', type: 'radio', checked: cfg.size === px,
        click: () => { cfg.size = px; saveCfg(); if (win) { win.setSize(px, px + BAR_H); win.webContents.send('ui:size', px); } }
      }))
    },
    {
      label: 'Opacity', submenu: [100, 85, 70, 55].map(p => ({
        label: p + '%', type: 'radio', checked: Math.round(cfg.opacity * 100) === p,
        click: () => { cfg.opacity = p / 100; saveCfg(); if (win) win.setOpacity(cfg.opacity); }
      }))
    },
    { type: 'separator' },
    { label: 'Reset position', click: () => { cfg.x = cfg.y = null; saveCfg(); if (win) { win.close(); createWindow(); } } },
    { label: 'Open Ade API', click: () => shell.openExternal(ADE_BASE + '/v1/health') },
    { label: 'Restart Ade OS…', click: async () => { const r = await ade('/v1/restart', { method: 'POST', body: {} }); dialogNote(r.ok ? 'Restart requested.' : 'Restart failed: ' + (r.error || r.status)); } },
    { type: 'separator' },
    { label: 'Quit avatar', click: () => { app.quit(); } }
  ]);
}
function dialogNote(msg) { if (win && !win.isDestroyed()) win.webContents.send('ui:note', msg); }

let smokeLogs = null;
const shortcuts = { bar: null, talk: null };
let pttOn = false, pttTimer = null;
const PTT_MAX_MS = 8000;
function togglePtt() {
  if (!win || win.isDestroyed()) return;
  if (pttOn) {
    pttOn = false;
    if (pttTimer) { clearTimeout(pttTimer); pttTimer = null; }
    win.webContents.send('ui:pttUp');
  } else {
    pttOn = true;
    win.webContents.send('ui:pttDown');
    pttTimer = setTimeout(() => { if (pttOn) togglePtt(); }, PTT_MAX_MS);
  }
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 20, height: 20 }));
  tray.setToolTip('Ade OS avatar');
  tray.on('click', () => win && win.webContents.send('ui:toggleBar'));
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

/* -------------------------------------------------------------------- IPC */
/* Named, not inline, so --smoke's pttUp drive can swap it out for a recorder
   and restore exactly this -- see startSmokeRun()'s pttSmoke block. */
function handleAdeCall(_e, pathname, method, body) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/v1/')) {
    return { ok: false, status: 0, error: 'refused: only /v1/* on the local Ade OS' };
  }
  return ade(pathname, { method: method || 'GET', body: body || null, timeout: 120000 });
}
ipcMain.handle('ade:call', handleAdeCall);
ipcMain.handle('ade:state', () => state);
ipcMain.handle('cfg:get', () => cfg);
ipcMain.handle('app:shortcuts', () => shortcuts);
ipcMain.handle('cfg:speak', () => !!cfg.speak);
/* The renderer owns the microphone; main only mirrors its state for the tray
   label and remembers the preference. Asking main whether the mic is open
   would be asking the wrong process. */
ipcMain.on('mic:state', (_e, live) => {
  micLive = !!live;
  if (cfg.mic !== micLive) { cfg.mic = micLive; saveCfg(); }
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('mic:state', micLive);
});
ipcMain.handle('threads:load', () => {
  try { return loadThreads(threadsPath()); } catch (e) { return { chat: [], shell: [], task: [] }; }
});
ipcMain.on('threads:save', (_e, data) => queueThreadsSave(data));
ipcMain.on('chat:open', (_e, tab) => openChat(tab));
ipcMain.on('chat:hide', () => {
  flushThreads();
  if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
});
ipcMain.on('mic:toggle', () => win && win.webContents.send('ui:micToggle'));
ipcMain.handle('mic:status', () => !!micLive);
ipcMain.handle('ade:speak', (_e, text) => adeSpeak(text));

ipcMain.handle('win:dragStart', () => {
  if (!win) return null;
  const [wx, wy] = win.getPosition();
  const c = screen.getCursorScreenPoint();
  dragAnchor = { wx, wy, cx: c.x, cy: c.y };
  return dragAnchor;
});
ipcMain.on('win:dragMove', () => {
  if (!win || !dragAnchor) return;
  const c = screen.getCursorScreenPoint();
  win.setPosition(dragAnchor.wx + (c.x - dragAnchor.cx), dragAnchor.wy + (c.y - dragAnchor.cy));
});
ipcMain.on('win:dragEnd', () => {
  dragAnchor = null;
  if (!win) return;
  const [nx, ny] = win.getPosition();
  cfg.x = nx; cfg.y = ny; saveCfg();
});
/* The renderer is the only thing that knows where the glyph actually is, so
   it reports whether the cursor is on painted pixels and main acts on it. */
ipcMain.on('win:hit', (_e, on) => { overPaint = !!on; applyHit(); });
ipcMain.on('win:bar', (_e, open) => {
  barOpen = !!open;
  applyHit();
  if (!win || win.isDestroyed()) return;
  if (barOpen) win.focus();
  else win.blur();                     /* hand the keyboard back to whatever had it */
});
ipcMain.on('app:menu', () => tray && tray.popUpContextMenu(buildMenu()));
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text || '')));

/* -------------------------------------------------------------- lifecycle */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { openChat(); });

  app.whenReady().then(() => {
    loadCfg();
    createWindow();
    createTray();
    createChatWindow();
    pollAde();
    timer = setInterval(pollAde, 2000);

    const { globalShortcut } = require('electron');
    /* globalShortcut is system-wide: whatever is taken here is taken from
       every other application. Alt+Space (Windows' own window menu) and
       Super+Space (the input-language switcher) used to head this list and
       always won, so the avatar quietly removed both from everything else on
       the desktop. Neither is asked for any more -- an ornament does not get
       to hold an OS key. A registration that fails silently is still
       indistinguishable from a dead app, so every result is recorded and the
       tray menu shows whichever one actually bound. */
    const wanted = [
      ['bar', ['Control+Alt+A', 'Control+Shift+A', 'Control+Alt+G'], () => win && win.webContents.send('ui:toggleBar')],
      ['talk', ['Control+Alt+Space', 'Control+Shift+Space', 'Control+Alt+V'],
        () => win && win.webContents.send('ui:micToggle')]
    ];
    for (const [name, combos, fn] of wanted) {
      shortcuts[name] = null;
      for (const combo of combos) {
        let ok = false;
        try { ok = globalShortcut.register(combo, fn); } catch (e) { ok = false; }
        if (ok && globalShortcut.isRegistered(combo)) { shortcuts[name] = combo; break; }
      }
    }
    /* globalShortcut has no key-up, so push-to-talk is press-to-start /
       press-to-stop, with a hard stop so a forgotten hotkey cannot leave the
       microphone open indefinitely -- see PTT_MAX_MS. There was a bare
       register('Control+Alt+Space') here as well, left over from before the
       fallback list existed: it re-grabbed the very combination the loop had
       just decided it could not have, and bound a key the tray menu did not
       report. */

    if (SMOKE) startSmokeRun();
  });

  app.on('window-all-closed', () => { /* the tray keeps it alive */ });
  app.on('will-quit', () => {
    if (timer) clearInterval(timer);
    flushThreads();
    try { require('electron').globalShortcut.unregisterAll(); } catch (e) {}
  });
}

/* A headless self-check: confirm the window really is frameless, transparent
   and on top, that the glyph painted pixels AND left the corners clear, and
   report what Ade looks like from here. Runs only with --smoke, then exits. */
function startSmokeRun() {
  /* renderer errors are invisible from here otherwise, and a throw in ui.js
     leaves the glyph drawing while nothing responds -- exactly the failure
     that is hardest to tell apart from "it is just a picture". */
  const logs = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logs.push('[' + (sourceId || '').split('/').pop() + ':' + line + '] ' + message);
  });
  win.webContents.on('preload-error', (_e, p2, err) => logs.push('PRELOAD ' + p2 + ': ' + err));
  smokeLogs = logs;
  const waitArg = (process.argv.find(a => a.startsWith('--smoke-wait=')) || '').split('=')[1];
  const wait = Math.max(500, parseInt(waitArg || '1500', 10) || 1500);
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, wait));
    let probe = {};
    try {
      probe = JSON.parse(await win.webContents.executeJavaScript(
        'JSON.stringify({ glyphApi: !!window.GLYPH, bar: !!document.getElementById("bar"),' +
        ' bodyBg: getComputedStyle(document.body).backgroundColor,' +
        ' litPixels: (function(){ var c=document.getElementById("glyph"); if(!c) return -1;' +
        ' var d=c.getContext("2d").getImageData(0,0,c.width,c.height).data, n=0;' +
        ' for(var i=3;i<d.length;i+=4) if(d[i]>10) n++; return n; })(),' +
        ' clearPixels: (function(){ var c=document.getElementById("glyph"); if(!c) return -1;' +
        ' var d=c.getContext("2d").getImageData(2,2,40,40).data, n=0;' +
        ' for(var i=3;i<d.length;i+=4) if(d[i]<=10) n++; return n; })() })'
      ));
      /* prove the speech path end to end: bridge -> Ade -> WAV -> decodable */
      probe.speech = JSON.parse(await win.webContents.executeJavaScript(
        '(async function(){ try {' +
        ' var r = await window.adeBridge.speak("Ade avatar voice check.");' +
        ' if(!r || !r.ok) return JSON.stringify({ok:false, err:(r&&r.error)||"no reply"});' +
        ' var raw=atob(r.wav), n=raw.length, b=new Uint8Array(n);' +
        ' for(var i=0;i<n;i++) b[i]=raw.charCodeAt(i);' +
        ' var ac=new (window.AudioContext||window.webkitAudioContext)();' +
        ' var buf=await ac.decodeAudioData(b.buffer);' +
        ' return JSON.stringify({ok:true, bytes:n, seconds:+buf.duration.toFixed(2), rate:buf.sampleRate});' +
        ' } catch(e){ return JSON.stringify({ok:false, err:String(e&&e.message||e)}); } })()'
      ));
    } catch (e) { probe = { error: String(e && e.message || e) }; }
    try {
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'smoke.png'), shot.toPNG());
      probe.capture = 'smoke.png';
    } catch (e) { probe.capture = 'failed: ' + String(e && e.message || e); }
    let interact = {};
    try {
      interact = JSON.parse(await win.webContents.executeJavaScript(
        '(function(){ var c=document.getElementById("glyph"), b=document.getElementById("bar");' +
        ' function fire(t){ c.dispatchEvent(new MouseEvent(t,{bubbles:true,button:0,screenX:10,screenY:10})); }' +
        ' function up(){ window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,button:0,screenX:10,screenY:10})); }' +
        ' var before = b.classList.contains("open"); fire("mousedown"); up();' +
        ' return JSON.stringify({ barBefore:before, barAfter:b.classList.contains("open"),' +
        '   hasPTT: typeof window.PTT, bridge: typeof window.adeBridge,' +
        '   listeners: !!(window.GLYPH && window.GLYPH.setSpeaking) }); })()'
      ));
    } catch (e) { interact = { error: String(e && e.message || e) }; }

    /* The window is a rectangle and the avatar is not, so prove the mouse is
       handed back everywhere the avatar is not drawn -- and, just as much,
       that it is NOT handed back where it is. A click-through window that is
       click-through over its own glyph is just as broken. */
    /* The hint line must name the key that actually bound, and no OS key may
       have been taken to get one. Both were wrong at once: it advertised
       Ctrl+Alt+Space while Ctrl+Shift+Space was live, and Alt+Space had been
       taken from every other application to open the bar. */
    let keys = {};
    try {
      const shown = await win.webContents.executeJavaScript(
        '(document.getElementById("talkKey")||{}).textContent || ""');
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

    /* Speech cannot carry the bar's prefixes -- classify() keys on "!", "?"
       and "/", none of them speakable. The rewrite is what lets one classifier
       serve both, and shell must still require a human beat. */
    let voice = {};
    try {
      voice = JSON.parse(await win.webContents.executeJavaScript(
        'JSON.stringify({' +
        ' shell: window.__spokenToTyped("shell git status"),' +
        ' ask: window.__spokenToTyped("ask what brain are you on"),' +
        ' task: window.__spokenToTyped("task qa run the suite"),' +
        ' bare: window.__spokenToTyped("run the trust level tests"),' +
        ' normHealth: window.__normalizeSpoken("Check the health.") })'));
      voice.rewrites = {
        shell: voice.shell, ask: voice.ask, task: voice.task, bare: voice.bare,
      };
      /* The property this task exists to protect: recognised shell text is
         PREFIXED for the bar, not dispatched. Confirming voice.shell has "!"
         only proves the rewrite is right; it says nothing about whether the
         rewrite itself pushed the text into the bar and fired it. The second
         clause below asserts that separately -- it reads the bar's own input
         element after the rewrite ran and requires it to still be untouched,
         which is what "recognition alone did not execute it" actually means. */
      voice.shellNeedsConfirm = await win.webContents.executeJavaScript(
        '(function(){ var before = document.getElementById("in").value;' +
        ' var t = window.__spokenToTyped("shell git status");' +
        ' var after = document.getElementById("in").value;' +
        ' return t.charAt(0) === "!" && after === before; })()');
      /* Whisper capitalises and punctuates; VOICE_ACTIONS' 9 keys are bare
         lowercase. Confirm the normaliser used ahead of that lookup actually
         collapses the two. */
      voice.normOk = voice.normHealth === 'check the health';
      voice.ok = voice.shell === '!git status'
              && voice.ask === '?what brain are you on'
              && voice.task === '/qa run the suite'
              && voice.bare === 'run the trust level tests'
              && voice.shellNeedsConfirm === true
              && voice.normOk === true;
    } catch (e) { voice = { error: String((e && e.message) || e) }; }

    /* shellNeedsConfirm above calls spokenToTyped() in isolation -- a pure
       string transform with no DOM access, so "the input didn't change" is
       true BY CONSTRUCTION and would stay true even if pttUp() were rewritten
       to auto-submit a shell rewrite. This block exercises the REAL pttUp()
       instead, with a stubbed recogniser, and checks that recognition alone
       never reaches /v1/terminal -- the property this task exists to protect.

       window.adeBridge.call cannot be stubbed from the renderer: contextBridge
       deep-freezes everything it exposes (verified live: Object.isFrozen(
       window.adeBridge) is true, and call's own property descriptor is
       {writable:false, configurable:false} -- an assignment to it silently
       no-ops rather than throwing). window.PTT is an ordinary object ui.js
       builds itself, NOT frozen, so PTT.stop/isActive stub the way the plan
       expected. What replaces the bridge stub is interception one layer
       down, at the 'ade:call' IPC handler in THIS process -- ordinary
       main-process code, nothing frozen about it. */
    let pttSmoke = {};
    try {
      const dispatched = [];
      ipcMain.removeHandler('ade:call');
      ipcMain.handle('ade:call', async (_e, pathname) => {
        dispatched.push(pathname);
        return { ok: true, status: 200, data: { stub: true } };
      });
      try {
        await win.webContents.executeJavaScript(
          '(function(){' +
          ' window.__pttSmokeOrigStop = window.PTT.stop;' +
          ' window.__pttSmokeOrigActive = window.PTT.isActive;' +
          ' window.PTT.stop = function(){ return Promise.resolve({ ok: true, text: "shell git status" }); };' +
          ' window.PTT.isActive = function(){ return true; };' +
          ' })()');
        await win.webContents.executeJavaScript(
          'window.__pttUp ? window.__pttUp() : Promise.reject(new Error("__pttUp not exposed"))');
        await new Promise((r) => setTimeout(r, 300));   /* let send()'s IPC round trip land if it fired */
        pttSmoke = JSON.parse(await win.webContents.executeJavaScript(
          'JSON.stringify({' +
          ' barValue: document.getElementById("in").value,' +
          ' barOpen: document.getElementById("bar").classList.contains("open") })'));
      } finally {
        await win.webContents.executeJavaScript(
          '(function(){' +
          ' window.PTT.stop = window.__pttSmokeOrigStop;' +
          ' window.PTT.isActive = window.__pttSmokeOrigActive;' +
          ' delete window.__pttSmokeOrigStop; delete window.__pttSmokeOrigActive;' +
          ' })()').catch(() => {});
        ipcMain.removeHandler('ade:call');
        ipcMain.handle('ade:call', handleAdeCall);
      }
      pttSmoke.dispatched = dispatched;
      pttSmoke.noDispatch = dispatched.indexOf('/v1/terminal') === -1
        && dispatched.indexOf('/v1/tasks') === -1
        && dispatched.every((p) => p.indexOf('/v1/approvals') !== 0);
      pttSmoke.ok = pttSmoke.barValue === '!git status' && pttSmoke.barOpen === true && pttSmoke.noDispatch === true;
    } catch (e) { pttSmoke = { error: String((e && e.message) || e) }; }
    voice.pttSmoke = pttSmoke;
    voice.ok = (voice.ok === true) && (pttSmoke.ok === true);

    /* The always-live microphone's three load-bearing properties. Each is
       asserted against the REAL renderer functions, not a restatement of the
       code, and each is falsifiable by breaking the thing it guards. */
    let mic = {};
    try {
      const js = (s) => win.webContents.executeJavaScript(s);
      /* 1. the wake word gates dispatch: speech not addressed to Ade is dropped
            BEFORE classification, so nothing can be dispatched by it */
      mic.wakeStrips = await js('window.__stripWake("Ade, run the tests")');
      mic.wakeStripsHey = await js('window.__stripWake("Hey Ade run the tests")');
      mic.nonWakeDropped = await js('window.__stripWake("the deploy finished, we should go home") === null');
      /* 2. an un-addressed utterance dispatches NOTHING. Drive the real
            onUtterance with the ade:call recorder already installed below. */
      /* 3. mute STOPS THE TRACK rather than ignoring results -- a mute that
            leaves the mic open is a lie told by a checkbox. */
      mic.tracksBeforeMute = await js('window.PTT._tracks()');
      await js('window.PTT.mute(), 0');
      mic.tracksAfterMute = await js('window.PTT._tracks()');
      mic.isMutedAfter = await js('window.PTT.isMuted()');
      mic.isLiveAfter = await js('window.PTT.isLive()');
      mic.ok = mic.wakeStrips === 'run the tests'
            && mic.wakeStripsHey === 'run the tests'
            && mic.nonWakeDropped === true
            && mic.tracksAfterMute === 0
            && mic.isMutedAfter === true
            && mic.isLiveAfter === false;
    } catch (e) { mic = { error: String((e && e.message) || e) }; }

    /* Ray, 2026-08-28: "it doesn't show it's hearing me". The orb had ONE
       channel -- setSpeaking() -- fed both by Ade's own voice and by the live
       microphone, so being heard and being talked at looked identical. And
       setMic() stored MIC_OPEN, which nothing ever read, so an open
       microphone looked exactly like a deaf one -- the thing the comment
       above that variable already said people are right to dislike.

       Measured off the rendered canvas, not restated from the code. The glyph
       animates continuously, so a single before/after pair would differ no
       matter what -- exactly the guard that keeps passing once the fix is
       deleted. These ALTERNATE the two settings and compare the gap between
       the arms against the spread WITHIN each arm, so the storyboard's own
       drift lands on both arms and only a real, visible difference clears. */
    let hearing = {};
    try {
      const js = (s2) => win.webContents.executeJavaScript(s2);
      const settle = (ms) => new Promise((r) => setTimeout(r, ms || 110));
      /* Cool light, summed and weighted by alpha. A plain lit-pixel count reads
         the same to the pixel either way -- the backing halo covers a fixed area
         and saturates it -- and a mean over lit pixels dilutes a local mark into
         nothing. This measures how much blue-over-red light is on the canvas;
         the halo contributes a constant that cancels between the paired arms,
         so what is left is the mark itself. */
      /* Cool light -- blue over red, weighted by alpha -- summed over three nested
         regions. A lit-pixel count reads the same to the pixel either way (the
         backing halo covers a fixed area and saturates it), and a mean over lit
         pixels dilutes a local mark to nothing. The halo's own faint coolness is a
         constant that cancels between the paired arms.

         Three regions because the signal is central and the variance is not: the
         starfield, particles and arcs churn across the whole frame, so a
         whole-canvas sum measures mostly them. `core` is where these cues draw. */
      const sample = () => js(
        '(function(){var c=document.getElementById("glyph"), w=c.width, h=c.height;' +
        ' var d=c.getContext("2d").getImageData(0,0,w,h).data;' +
        ' var cool=0, lum=0, ringCool=0, ringLum=0, n=0, coolPx=0;' +
        ' var cx=w/2, cy=h/2, m=Math.min(w,h), r0=m*0.15, r1=m*0.45;' +
        ' for(var y=0;y<h;y++){ for(var x=0;x<w;x++){ var i=(y*w+x)*4, A=d[i+3];' +
        '   if(A<=10) continue; n++;' +
        '   var a=A/255, v=(d[i+2]-d[i])*a, L=(d[i]+d[i+1]+d[i+2])*a;' +
        '   cool+=v; lum+=L;' +
        '   if(d[i+2]-d[i] > 25) coolPx++;' +
        '   var dx=x-cx, dy=y-cy, rr=Math.sqrt(dx*dx+dy*dy);' +
        '   if(rr>=r0&&rr<r1){ ringCool+=v; ringLum+=L; } } }' +
        ' return JSON.stringify({lit:n, cool:cool/1000, lum:lum/1000, coolPx:coolPx,' +
        '   hue: lum? cool/lum*1000 : 0, ringHue: ringLum? ringCool/ringLum*1000 : 0});})()'
      ).then(JSON.parse);
      const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
      const spread = (xs) => Math.max.apply(null, xs) - Math.min.apply(null, xs);
      /* Paired DIFFERENCES, not two pooled arms. The glyph runs a 24s storyboard,
         so samples drift steadily over the second or so a run takes -- pooling the
         arms measures that drift as if it were noise and buries the signal. Taking
         A and B back to back and differencing each pair cancels the drift where it
         happens; what is left in the spread of those differences is real jitter. */
      const KEYS = ['cool', 'lum', 'hue', 'coolPx'];

      /* WAIT FOR THE FIGURE. assembly() fades the whole glyph to nothing for
         about 4.6s of every 24s cycle, and every cue is multiplied by asm, so a
         probe that starts in the fade measures zero and reports it as "the cue
         does not work". This is why the same suite gave 116x and 1.16x on
         consecutive runs for the same code -- the results were tracking the
         storyboard's phase, not the code. Sample the cycle, learn how bright the
         figure gets, then start only when it is actually on screen. */
      async function awaitFigure() {
        let max = 0;
        for (let i = 0; i < 26; i++) {           /* ~6s: enough to see the peak */
          const v = (await sample()).lum;
          if (v > max) max = v;
          await settle(230);
        }
        for (let i = 0; i < 90; i++) {           /* then wait for it to come back */
          const v = (await sample()).lum;
          if (v >= 0.80 * max) return { peak: +max.toFixed(1), at: +v.toFixed(1), waited: i };
          await settle(230);
        }
        return { peak: +max.toFixed(1), at: -1, waited: -1 };
      }
      hearing.figure = await awaitFigure();
      async function paired(setA, setB, key, ms, reps) {
        const rows = [];
        for (let i = 0; i < (reps || 3); i++) {
          await js(setA); await settle(ms || 260); const a = await sample();
          await js(setB); await settle(ms || 260); const b = await sample();
          rows.push([a, b]);
        }
        const per = {};
        KEYS.forEach((k) => {
          const D = rows.map(([a, b]) => a[k] - b[k]);
          /* with several reps the mean is known better than any single pair is,
             so the bar is the standard error rather than the raw spread */
          const noise = Math.max(spread(D) / Math.sqrt(D.length), 1e-6);
          const signal = Math.abs(mean(D));
          per[k] = { diff: +mean(D).toFixed(2), noise: +noise.toFixed(2),
                     ratio: +(signal / noise).toFixed(2), clears: signal > 3 * noise };
        });
        const chosen = per[key];
        return { a: +mean(rows.map((r) => r[0][key])).toFixed(2),
                 b: +mean(rows.map((r) => r[1][key])).toFixed(2),
                 diff: chosen.diff, noise: chosen.noise, signal: +Math.abs(chosen.diff).toFixed(2),
                 clears: chosen.clears, byRegion: per };
      }

      /* the two channels exist at all -- so losing one fails as a named missing
         function rather than as an opaque throw from the first probe */
      hearing.api = JSON.parse(await js(
        'JSON.stringify({ hear: typeof window.GLYPH.setHearing,' +
        ' speak: typeof window.GLYPH.setSpeaking, wake: typeof window.GLYPH.wake,' +
        ' mic: typeof window.GLYPH.setMic })'));
      hearing.apiOk = hearing.api.hear === 'function' && hearing.api.speak === 'function'
                   && hearing.api.wake === 'function' && hearing.api.mic === 'function';
      /* does the input even arrive? A cue that is not drawn and an input that
         never rose look the same in a screenshot. */
      await js('(window.GLYPH.setHearing(0),window.GLYPH.setSpeaking(0)),0');
      await js('window.GLYPH.setMic(1),0'); await settle(400);
      hearing.stateOn = JSON.parse(await js('JSON.stringify(window.GLYPH._state())'));
      await js('window.GLYPH.setMic(0),0'); await settle(400);
      hearing.stateOff = JSON.parse(await js('JSON.stringify(window.GLYPH._state())'));

      /* 1. An open microphone does not look like a deaf one.
         340ms because micLit fades in 0.10s -- alternating faster than the fade
         never lets either arm arrive and measures the middle against itself.
         Ten reps and the STANDARD ERROR of the mean rather than the raw spread:
         the resting cue is a 22% tint and is meant to be quiet, because the mic
         is open by default and the glyph is gold -- an always-on cue loud enough
         to clear 3x against a single pair would repaint the piece. A small real
         effect is measured by sampling it more often, not by turning it up until
         the threshold is met, which would be tuning the product to the test. */
      /* NOT in hearing.ok, and deliberately so. Measured at ~52 units of cool
         against ~260 of storyboard drift; clearing 3x on the standard error would
         need something like 230 reps, and the alternative -- turning the cue up
         until it clears -- would leave a gold piece permanently teal, since the
         microphone is open by default. So the number is reported and watched, and
         the claim it supports is only that the direction is right. If the resting
         indicator ever needs to be provable, it has to become a visible design
         element first; a guard must not be the reason a design gets louder. */
      await awaitFigure();
      hearing.micCue = await paired('window.GLYPH.setMic(1),0', 'window.GLYPH.setMic(0),0', 'cool', 340, 10);
      await js('window.GLYPH.setMic(1),0');
      /* 2. your voice moves it while you are speaking */
      hearing.hearCue = await paired('window.GLYPH.setHearing(0.95),0', 'window.GLYPH.setHearing(0),0', 'lum', 300);
      /* 3. and it is NOT the same look as Ade talking back. Both arms are measured
            against IDLE rather than against each other: comparing the two voices
            head to head passes even with the hearing channel deleted, because
            Ade's voice alone moves the frame and the comparison cannot tell
            "yours is cool" from "his is warm". Against idle, each channel has to
            show its own effect, and they have to point opposite ways. */
      hearing.yoursAddsCool = await paired(
        '(window.GLYPH.setSpeaking(0),window.GLYPH.setHearing(0.95)),0',
        '(window.GLYPH.setSpeaking(0),window.GLYPH.setHearing(0)),0', 'coolPx', 300);
      hearing.adesNoCool = await paired(
        '(window.GLYPH.setHearing(0),window.GLYPH.setSpeaking(0.95)),0',
        '(window.GLYPH.setHearing(0),window.GLYPH.setSpeaking(0)),0', 'coolPx', 300);
      /* Ade's voice must put no cool light on the figure while yours does. Stated
         as a ratio rather than a sign: counting cool pixels, "his is warm" is not
         a negative count, it is the absence of one, and demanding diff <= 0 just
         fails on noise around zero. */
      hearing.channelsOppose = hearing.yoursAddsCool.diff > 10 * Math.abs(hearing.adesNoCool.diff);
      await js('(window.GLYPH.setSpeaking(0),window.GLYPH.setHearing(0)),0');

      /* Ray, 2026-08-28: "i want the glyph itself to respond to speech, not a ring
         around it". The piece already had an audio path -- five bands onto the
         five shells in stageGlow(), loudness into res, flux onsets into arcs --
         armed only when it runs as artwork. The avatar now feeds it the analyser
         from the microphone ptt.js already holds.

         Driven here with a real Web Audio graph rather than by poking values in:
         an oscillator through an AnalyserNode, exactly what a voice arrives as.
         If the wiring is broken this measures nothing, which is the point. */
      hearing.audioDrives = {};
      try {
        await js(
          '(function(){ var AC = window.AudioContext||window.webkitAudioContext;' +
          ' var ac = new AC(); var osc = ac.createOscillator(); osc.type = "sawtooth";' +
          ' osc.frequency.value = 190; var g = ac.createGain(); g.gain.value = 0;' +
          ' var an = ac.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.5;' +
          ' an.minDecibels = -96; an.maxDecibels = -12;' +
          ' var mute = ac.createGain(); mute.gain.value = 0;' +
          ' osc.connect(g); g.connect(an); an.connect(mute); mute.connect(ac.destination);' +
          ' osc.start(); if(ac.resume) ac.resume();' +
          ' window.__smokeVoice = { on:function(){ g.gain.value = 0.7;' +
          '   window.GLYPH.attachAudio(an, ac.sampleRate); },' +
          '   off:function(){ g.gain.value = 0; window.GLYPH.detachAudio(); } };})(),0');
        hearing.audioDrives = await paired(
          'window.__smokeVoice.on(),0', 'window.__smokeVoice.off(),0', 'lum', 420);
        hearing.audioAttaches = await js(
          '(function(){ window.__smokeVoice.on();' +
          ' var v = window.GLYPH.isHearingAudio(); window.__smokeVoice.off(); return v; })()');
        hearing.audioDetaches = await js('window.GLYPH.isHearingAudio() === false');
      } catch (e) { hearing.audioDrives = { error: String((e && e.message) || e) }; }

      /* And the wake word fires through the geometry, not around it. NOT paired():
         the flash decays over 450ms, so an A/B alternation samples arm B while
         arm A is still fading and measures the difference between a flash and a
         half-flash. Each rep waits the flash out, takes the baseline, then fires
         and samples while it is bright. */
      try {
        /* Against a NULL CONTROL, not against its own spread. Reading the canvas
           takes a variable slice of the 450ms the flash lives for, so the same
           flash measures differently run to run; comparing that spread to itself
           calls a working flash noise. The null arm is the identical measurement
           with the wake() removed -- so it captures exactly that jitter, and the
           only thing left between the arms is the flash. */
        /* PEAK over the flash's life, not one sample inside it: reading the canvas
           takes a variable slice of the 450ms it lives for, so a single timed
           sample lands on the peak sometimes and on the tail other times. And in
           `lum`, because the flare is brighter arcs and hotter nodes -- it is not
           cooler, so measuring it in blue measured the wrong thing and duly came
           back with the wrong sign. */
        const pulse = async (fire) => {
          await settle(520);                       /* let any previous flash die */
          const before = (await sample()).lum;
          if (fire) await js('window.GLYPH.wake(),0');
          let peak = -1e9;
          for (let k = 0; k < 3; k++) { const v = (await sample()).lum; if (v > peak) peak = v; }
          return peak - before;
        };
        const D1 = [], D0 = [];
        await awaitFigure();
        for (let i = 0; i < 4; i++) { D1.push(await pulse(true)); D0.push(await pulse(false)); }
        const noise = Math.max(spread(D0) / 2, Math.abs(mean(D0)), 1e-6);
        const signal = Math.abs(mean(D1));
        hearing.wakeRender = { diff: +mean(D1).toFixed(2), nullDiff: +mean(D0).toFixed(2),
                               noise: +noise.toFixed(2), ratio: +(signal / noise).toFixed(2),
                               brighter: mean(D1) > 0, clears: signal > 3 * noise };
        await settle(560);
      } catch (e) { hearing.wakeRender = { error: String((e && e.message) || e) }; }

      /* what the three states actually look like, side by side on disk -- the
         numbers above say a difference exists, not whether it reads as one */
      const shots = { mic1: 'smoke-listening.png', hear: 'smoke-hearing.png', off: 'smoke-mic-off.png' };
      const capture = async (name) => {
        await settle(320);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, name), img.toPNG());
      };
      await js('(window.GLYPH.setMic(0),window.GLYPH.setHearing(0),window.GLYPH.setSpeaking(0)),0');
      await capture(shots.off);
      await js('(window.GLYPH.setMic(1),window.GLYPH.setHearing(0)),0');
      await capture(shots.mic1);
      await js('window.GLYPH.setHearing(0.85),0');
      await capture(shots.hear);
      await js('window.GLYPH.setHearing(0),0');
      hearing.shots = shots;

      /* 4. the wake word flares the moment it matches -- the one cue that says
            "this one is for me" BEFORE recognition has finished. Driven
            through the real onUtterance, with a phrase that is not a
            VOICE_ACTION so nothing is dispatched by the check itself. */
      const barBefore = await js('document.getElementById("bar").classList.contains("open")');
      const inBefore = await js('document.getElementById("in").value');
      await js('(function(){ window.__wakeCalls = 0; var w = window.GLYPH.wake;' +
               ' window.GLYPH.wake = function(){ window.__wakeCalls++; return w.apply(this, arguments); }; })(),0');
      await js('window.__onUtterance({text:"Ade, remember the milk"}),0');
      await settle(80);
      hearing.wakeCalls = await js('window.__wakeCalls');
      await js('window.__wakeCalls = 0,0');
      await js('window.__onUtterance({text:"the deploy finished, we should go home"}),0');
      await settle(80);
      hearing.nonWakeCalls = await js('window.__wakeCalls');
      /* leave the bar exactly as found -- hit's probe below asserts on it */
      await js('(function(){document.getElementById("in").value=' + JSON.stringify(inBefore) + ';' +
               ' document.getElementById("bar").classList.toggle("open",' + (barBefore ? 'true' : 'false') + ');})(),0');

      hearing.ok = hearing.apiOk === true
                && hearing.figure.at > 0
                && hearing.audioDrives.clears === true
                && hearing.audioAttaches === true
                && hearing.audioDetaches === true
                && hearing.wakeRender.clears === true
                && hearing.wakeRender.brighter === true
                && hearing.yoursAddsCool.clears === true
                /* direction too: clears() is |signal| > 3*noise and says nothing
                   about sign, so without this a cue that went the WRONG way -- as
                   it does with the tint deleted -- still counts as a pass */
                && hearing.yoursAddsCool.diff > 0
                && hearing.channelsOppose === true
                && hearing.wakeCalls === 1
                && hearing.nonWakeCalls === 0;
    } catch (e) { hearing = { error: String((e && e.message) || e) }; }

    /* `/word` must reach a ROUTE, not a dead end. Ray, 2026-08-27, trying to
       use skills from the bar: "nothing happens, it says Nothing to send".
       classify() demanded `\s+([\s\S]+)` after the type, so a lone `/word`
       came back with text:'' and send() refused it -- while the hint line was
       advertising `/type` as the way to do exactly that.

       Asserted against the REAL classify(), and falsifiable: put the `+` back
       and skillVerb/typeKeepsWord go wrong.

       plainAsksNow (was plainStaysTask, until Task 9): bare text used to fall
       through to `{kind:'task', type:'coding'}` here too -- a `/word` dead end
       and an un-reviewed bare Task shared the same fallback branch. Task 9
       gave bare text its own meaning (kind 'ask', route 'ground' -- see
       smoke.ask below) so this now asserts THAT contract instead of the one
       it replaced; smoke.ask.bareInputAsks covers the same claim from the
       feature's own side. */
    let slash = {};
    try {
      const js = (s) => win.webContents.executeJavaScript(s);
      slash.skillVerb = await js('JSON.stringify(window.__classify("/skill"))');
      slash.skillNamed = await js('JSON.stringify(window.__classify("/skill brainstorming"))');
      slash.typeKeepsWord = await js('window.__classify("/superpowers").type');
      slash.typeWithBody = await js('window.__classify("/qa run the suite").text');
      slash.plainAsksNow = JSON.parse(await js('JSON.stringify(window.__classify("fix the build"))'));
      slash.ok = JSON.parse(slash.skillVerb).kind === 'skill'
              && JSON.parse(slash.skillNamed).text === 'brainstorming'
              && slash.typeKeepsWord === 'superpowers'
              && slash.typeWithBody === 'run the suite'
              && slash.plainAsksNow.kind === 'ask'
              && slash.plainAsksNow.route === 'ground';
    } catch (e) { slash = { error: String((e && e.message) || e) }; }

    /* Talking to the glyph now ASKS -- POST /v1/ask, grounded against the
       three machine-access roots -- instead of dispatching a coding Task on
       Enter with no review step. /, ! and ? are untouched (asserted here
       too, so a change to classify() cannot silently widen). The second half
       is the property this task exists for: an escalation (a change request
       /v1/ask declines to perform) must stage a Task for a human's own Enter
       and never call dispatchTask() itself -- falsifiable by adding a
       dispatchTask() call inside applyAskResult()'s escalate branch, which
       makes ask.escalationDoesNotDispatch go false. */
    let ask = {};
    try {
      const js = (s) => win.webContents.executeJavaScript(s);
      const bareRoute = JSON.parse(await js('JSON.stringify(window.__classify("what is in glyph.js"))'));
      const taskRoute = JSON.parse(await js('JSON.stringify(window.__classify("/qa run the suite"))'));
      const shellRoute = JSON.parse(await js('JSON.stringify(window.__classify("!git status"))'));
      const chatRoute = JSON.parse(await js('JSON.stringify(window.__classify("?what brain are you on"))'));
      ask.bareInputAsks = bareRoute.kind === 'ask' && bareRoute.route === 'ground';
      ask.prefixStillDispatches = taskRoute.kind === 'task' && taskRoute.type === 'qa';
      ask.shellUnchanged = shellRoute.kind === 'shell';
      ask.explicitAskUnchanged = chatRoute.kind === 'ask' && chatRoute.route === 'chat';

      const before = await js('window.__dispatchCount()');
      const staged = await js(
        '(function(){ window.__applyAskResult({ answer: "", escalate: { task_type: "coding", prompt: "fix it" } });' +
        ' return document.getElementById("in").value; })()');
      const after = await js('window.__dispatchCount()');
      ask.escalationDoesNotDispatch = after === before;
      ask.escalationStagesTask = staged === '/coding fix it';

      /* Fix round 1 (Task 8+9 reviewer finding): three configured roots,
         one of them live trading code -- "Staged as a task" alone tells a
         human nothing about WHERE it would write. adeos/api/ask.py's
         _escalation_root() computes the real root; this only checks that
         applyAskResult() DISPLAYS whatever it was handed. Falsify by
         dropping the `where` clause in applyAskResult()'s escalate branch
         -- this goes false. */
      const namedRootOut = await js(
        '(function(){ window.__applyAskResult({ answer: "", escalate:' +
        ' { task_type: "coding", prompt: "fix it", root: "D:\\\\tradinglocal" } });' +
        ' return document.getElementById("out").textContent; })()');
      ask.escalationNamesRoot = namedRootOut.indexOf('D:\\tradinglocal') >= 0;

      /* A grounded reply with no escalate clears the bar and shows the
         answer, naming the root it read -- asserted against the real
         applyAskResult(), not a restatement of it. */
      const answered = await js(
        '(function(){ document.getElementById("in").value = "leftover";' +
        ' window.__applyAskResult({ answer: "glyph.js draws the core.", roots_cited: ["ade-ai"] });' +
        ' return JSON.stringify({ input: document.getElementById("in").value,' +
        ' out: document.getElementById("out").textContent }); })()');
      const a = JSON.parse(answered);
      ask.clearsInputOnAnswer = a.input === '';
      ask.namesCitedRoot = a.out.indexOf('ade-ai') >= 0 && a.out.indexOf('glyph.js draws the core.') >= 0;

      ask.ok = ask.bareInputAsks && ask.prefixStillDispatches && ask.shellUnchanged
             && ask.explicitAskUnchanged && ask.escalationDoesNotDispatch === true
             && ask.escalationStagesTask && ask.escalationNamesRoot
             && ask.clearsInputOnAnswer && ask.namesCitedRoot;
    } catch (e) { ask = { error: String((e && e.message) || e) }; }

    /* Upload, driven through the REAL walker against a REAL folder on disk.
       Not a restatement of the code: it builds a tree with a nested file, a
       skipped directory and a dotfile, walks it, and checks what came back.
       The POST is left to fail or succeed against whatever Ade OS is up --
       what is asserted here is the walk, the relative names and the skip
       reporting, which is the part that lives in this file. */
    let upload = {};
    try {
      const root = path.join(os.tmpdir(), 'ade-upload-smoke-' + process.pid);
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'proj', 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'proj', 'README.md'), '# hi');
      fs.writeFileSync(path.join(root, 'proj', 'src', 'a.py'), 'print(1)');
      fs.writeFileSync(path.join(root, 'proj', 'node_modules', 'junk.js'), 'x');

      const found = [], skipped = [];
      walkUpload(path.join(root, 'proj'), found, skipped);
      const rels = found.map(f => f.rel).sort();
      upload.found = rels;
      upload.skipped = skipped.map(s => s.path + ' — ' + s.why);
      /* the dropped folder keeps its own name on the far side */
      upload.keepsFolderName = rels.indexOf('proj/src/a.py') >= 0;
      upload.tookReadme = rels.indexOf('proj/README.md') >= 0;
      /* node_modules is skipped, and SAYS so rather than vanishing */
      upload.skipsNodeModules = rels.every(r => r.indexOf('node_modules') === -1)
        && skipped.some(s => s.path.indexOf('node_modules') >= 0);
      upload.ok = upload.keepsFolderName && upload.tookReadme
        && upload.skipsNodeModules && rels.length === 2;
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) { upload = { error: String((e && e.message) || e) }; }

    let hit = {};
    try {
      const settle = (ms) => new Promise(r => setTimeout(r, ms || 160));
      const move = (x, y) => win.webContents.executeJavaScript(
        'window.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:' + x + ',clientY:' + y + '})), 0');
      const click = () => win.webContents.executeJavaScript(
        '(function(){var c=document.getElementById("glyph");' +
        'c.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,screenX:9,screenY:9}));' +
        'window.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,button:0,screenX:9,screenY:9}));})(), 0');
      const snap = () => ({ ignoresMouse: lastIgnore, focusable: win.isFocusable() });
      await click(); await settle();          /* interact left the bar open; close it */
      hit.barClosed = snap();
      await move(4, 4); await settle();
      hit.overCorner = snap();                /* expect ignoresMouse true  */
      await move(230, 190); await settle();
      hit.overGlyph = snap();                 /* expect ignoresMouse false */
      await move(4, 4); await settle();
      hit.offAgain = snap();                  /* expect ignoresMouse true  */
      await click(); await settle();          /* open the bar: it needs the keyboard */
      hit.barOpen = snap();                   /* expect focusable true     */
      hit.ok = hit.overCorner.ignoresMouse === true
            && hit.overGlyph.ignoresMouse === false
            && hit.offAgain.ignoresMouse === true
            && hit.barClosed.focusable === false
            && hit.barOpen.focusable === true;
    } catch (e) { hit = { error: String((e && e.message) || e) }; }

    /* The chat window exists, is a real framed window, stays hidden until
       opened, draws the three tab names, and persists threads through the
       bridge. The temp threads path keeps the smoke run off Ray's real file. */
    let chatProbe = {};
    try {
      chatProbe.exists = !!(chatWin && !chatWin.isDestroyed());
      if (chatWin) {
        chatProbe.hiddenAtLaunch = !chatWin.isVisible();
        chatProbe.resizable = chatWin.isResizable();
        /* Electron 33 exposes setSkipTaskbar(skip) but no isSkipTaskbar() getter,
           so the taskbar assertion must degrade gracefully. */
        chatProbe.inTaskbar = chatWin.isSkipTaskbar ? !chatWin.isSkipTaskbar() : true;
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
      const js = (s) => chatWin.webContents.executeJavaScript(s);
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
        /* pollAde() keeps broadcasting approval:null to the chat window every
           2s, and handleState() demotes stale cards on that -- which would
           rae with this probe's own __showApproval(null)/s2/s3 assertions. The
           probe already drives state itself and stubs the network, so pause
           the live poll during it and let the finally restore it. */
        if (timer) clearInterval(timer);
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
        smsApproval.secondButtons = await js('document.querySelectorAll("#thread button.approve, #thread button.deny").length');

        await js('window.__showApproval(null),0');       /* resolved server-side */
        await new Promise((r) => setTimeout(r, 60));
        smsApproval.mootButtons = await js('document.querySelectorAll("#thread button.approve, #thread button.deny").length');
        smsApproval.mootText = (await js('document.getElementById("thread").textContent')).indexOf('no longer pending') >= 0;
        smsApproval.mootKeepsCards = (await js('document.querySelectorAll("#thread .msg.approval").length')) === 2;

        await js('window.__showApproval({ id: "s3", tool: "git.status", args: {} }),0');
        await new Promise((r) => setTimeout(r, 160));
        smsApproval.thirdCard = (await js('document.querySelectorAll("#thread .msg.approval").length')) === 3;
        smsApproval.thirdButtons = await js('document.querySelectorAll("#thread button.approve, #thread button.deny").length');

        smsApproval.ok = smsApproval.raised === true
          && smsApproval.tab === 'task'
          && smsApproval.cards === 1
          && smsApproval.namesTool === true
          && smsApproval.buttons === 2
          && smsApproval.decidePosted === true
          && smsApproval.buttonsAfterDecide === 0
          && smsApproval.decidedText === true
          && smsApproval.noDupe === true
          && smsApproval.secondCard === true
          && smsApproval.secondButtons === 2
          && smsApproval.mootButtons === 0
          && smsApproval.mootText === true
          && smsApproval.mootKeepsCards === true
          && smsApproval.thirdCard === true
          && smsApproval.thirdButtons === 2;
      } finally {
        await js('window.adeBridge.hideChat(),0').catch(() => {});
        await js('(function(){ var w = window.__threads();' +
                 ' w.task = w.task.filter(function(m){ return !(m.kind === "approval" && m.meta && /^s[123]$/.test(m.meta.approval && m.meta.approval.id)); });' +
                 ' window.adeBridge.threadsSave({ chat: w.chat, shell: w.shell, task: w.task }),0; })(),0').catch(() => {});
        ipcMain.removeHandler('ade:call');
        ipcMain.handle('ade:call', handleAdeCall);
        timer = setInterval(pollAde, 2000);
      }
    } catch (e) { smsApproval = { error: String((e && e.message) || e) }; }

    console.log('SMOKE ' + JSON.stringify({
      shortcuts,
      visible: win.isVisible(),
      chatProbe,
      slashChat,
      askChat,
      retryChat,
      smsApproval,
      bounds: win.getBounds(),
      workArea: screen.getDisplayMatching(win.getBounds()).workArea,
      tray: !!tray,
      clickThrough: !!cfg.clickThrough,
      interact,
      mic,
      hearing,
      hit,
      voice,
      keys,
      slash,
      ask,
      upload,
      rendererErrors: (smokeLogs || []).slice(0, 6),
      frameless: !win.isResizable(),
      alwaysOnTop: win.isAlwaysOnTop(),
      size: win.getSize(),
      probe,
      ade: state
    }));
    app.exit(0);
  });
}

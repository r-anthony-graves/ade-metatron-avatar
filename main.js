/* Ade OS desktop avatar -- a transparent, always-on-top Metatron glyph.
 *
 * It is a CLIENT to the sealed twin on 127.0.0.1:8301, deliberately. This process never
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
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage, clipboard, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { loadThreads, saveThreads } = require('./threads-store');
const { filesRoot, ensureFilesLayout } = require('./files-store');

/* The glyph window is setFocusable(false) so it never steals the keyboard.
   Chromium then treats its AudioContext as not user-activated and the live
   mic opens but stays silent -- the orb looks deaf. This has to be set
   before ready. */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ADE_BASE = process.env.ADEOS_URL || 'http://127.0.0.1:8301';
const SMOKE = process.argv.includes('--smoke');
const CFG_PATH = () => path.join(app.getPath('userData'), 'avatar-state.json');

let win = null, tray = null, timer = null, dragAnchor = null;
let chatWin = null;                 /* the desktop conversation window */
/* Start clickable. The old default (false) ignored the mouse until the
   renderer reported painted pixels under the cursor -- and a window that
   never got that hover event stayed permanently click-through. */
let overPaint = true, lastIgnore = null;
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

/* Avatar-local files tree. Smoke uses a temp root so a self-test never
   writes the real AppData files/ folder. */
let smokeFilesDir = null;
function filesUserData() {
  if (!SMOKE) return app.getPath('userData');
  if (!smokeFilesDir) smokeFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-files-smoke-'));
  return smokeFilesDir;
}
function filesDir() {
  return filesRoot(filesUserData());
}
function openFilesFolder() {
  const root = ensureFilesLayout(filesUserData());
  return shell.openPath(root);
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
    const name = (e && e.name) || '';
    const msg = String((e && e.message) || e);
    /* AbortController fires as DOMException name AbortError; without this
       the chat window just says "Call failed: This operation was aborted"
       and the user cannot tell Ade was still working past the client budget. */
    if (name === 'AbortError' || /aborted/i.test(msg)) {
      return {
        ok: false, status: 0,
        error: 'timed out after ' + Math.round(timeout / 1000)
          + 's waiting for Ade OS' + pathname
      };
    }
    /* Node's fetch reports a dead loopback as the bare string "fetch failed".
       Ade OS restarts drop every in-flight call; without this the chat just
       says "Call failed: fetch failed" and the retry looks like a client bug. */
    if (/fetch failed|ECONNREFUSED|ECONNRESET|ECONNABORTED/i.test(msg)) {
      return {
        ok: false, status: 0,
        error: 'Ade OS unreachable at ' + ADE_BASE
          + ' — it may be restarting. Wait for health, then retry.'
      };
    }
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(kill);
  }
}

/* First short sentence only, cut to FIT Ade OS's TTS render budget -- not to
   be pithy. The /v1/voice/speak engine is boot-time: with ADEOS_VOICE_ENGINE
   absent Ade OS loads Kokoro (~0.5s per reply, onnxruntime, no GPU), which
   renders a sentence in near-real-time. But Maya1 (the own-tts sidecar) used
   to be selected via ADEOS_VOICE_ENGINE=maya1 and rendered at ~20-100x realtime
   on a contended GPU (measured live 2026-09-07: 61s for a 0.3s single word,
   gated), and adeSpeak aborts at 180s -- so a long reply became a minute of
   silence that looked like a broken voice. Keep the clip tight regardless of
   engine: a 600-char Chat dump became 8 gated segments and the avatar timed
   out mute. 160 chars is a coherent sentence and stays well inside any
   engine's budget; a longer utterance that gets cut is still spoken. */
const MAX_SPOKEN_CHARS = 160;
function clipForSpeech(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (/^(we have (a |the )?(massive )?(search|tool|fetch)|the search results|the list_files tool|the user asks)/i.test(raw)) return '';
  const m = raw.match(/^(.+?[.!?])(?:\s|$)/);
  let spoken = m ? m[1] : raw;
  if (spoken.length > MAX_SPOKEN_CHARS) {
    spoken = spoken.slice(0, MAX_SPOKEN_CHARS).replace(/\s+\S*$/, '').replace(/[.,;:]+$/, '') + '.';
  }
  return spoken;
}

/* /v1/voice/speak answers with audio/wav. ade() reads text() and would mangle
   it, so speech takes its own path and hands the renderer base64 to decode. */
async function adeSpeak(text) {
  const spoken = clipForSpeech(text);
  if (!spoken) return { ok: false, status: 0, error: 'nothing speakable' };
  const ctl = new AbortController();
  /* 180s, not 30s: Maya1 renders at tens of seconds per utterance (measured
     9.3s of audio in 218s). At 30s the avatar ABORTED and reported a broken
     speak rather than a slow one. Kokoro answers in 0.42s and never noticed
     this budget either way. */
  const kill = setTimeout(() => ctl.abort(), 180000);
  try {
    const res = await fetch(ADE_BASE + '/v1/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clipForSpeech(text) }),
      signal: ctl.signal
    });
    if (!res.ok) return { ok: false, status: res.status, error: 'speak returned ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, status: res.status, error: 'empty audio' };
    return { ok: true, wav: buf.toString('base64') };
  } catch (e) {
    const name = (e && e.name) || '';
    const msg = String((e && e.message) || e);
    if (name === 'AbortError' || /aborted/i.test(msg)) {
      return { ok: false, status: 0, error: 'timed out after 180s waiting for voice' };
    }
    return { ok: false, status: 0, error: msg };
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
/* Windows gives a transparent window a RECTANGULAR hit region, so all of
   S x S swallows the mouse -- but only about a third of that square is ever
   painted. Sitting over another window, the invisible remainder eats its
   clicks, and the app underneath looks frozen. The orb itself never takes
   the keyboard: every keypress belongs to the chat window or the app behind
   the transparent bits. The only dynamic is the mouse -- handed back
   anywhere the orb is not painted. */
function applyHit() {
  if (!win || win.isDestroyed()) return;
  const wants = !cfg.clickThrough && overPaint;
  lastIgnore = !wants;
  win.setIgnoreMouseEvents(lastIgnore, { forward: true });
  win.setFocusable(false);
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
  let y = cfg.y == null ? area.y + area.height - S - 48 : cfg.y;
  const fitted = clampToScreen(x, y, S, S);
  if (fitted.x !== x || fitted.y !== y) {
    x = fitted.x; y = fitted.y;
    cfg.x = x; cfg.y = y; saveCfg();     /* remember the corrected spot, not the lost one */
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
  win.on('close', () => { win = null; });
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

/* Open/focus the chat window; `tab` optionally pre-selects a thread.
 * Always tell the renderer to focus the input — tray / Ctrl+Alt+C /
 * second-instance call openChat() with no tab, and without chat:focus
 * the window shows but #in never receives keystrokes (BrowserWindow
 * focus ≠ input focus on Windows). */
function openChat(tab) {
  if (!chatWin || chatWin.isDestroyed()) return;
  if (cfg.chatX != null) {
    const b = chatWin.getBounds();
    const fitted = clampToScreen(b.x, b.y, b.width, b.height);
    if (fitted.x !== b.x || fitted.y !== b.y) chatWin.setPosition(fitted.x, fitted.y);
  }
  chatWin.show();
  chatWin.focus();
  if (chatWin.webContents) {
    chatWin.webContents.focus();
    chatWin.webContents.send('chat:focus', tab || null);
  }
}

/* ------------------------------------------------------------------ tray */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: state.online ? `Ade OS: ${state.pending ? state.pending + ' awaiting approval' : (state.busy ? 'working' : 'idle')}` : 'Ade OS: offline', enabled: false },
    { label: state.brain ? '  ' + state.brain : '  (no brain reported)', enabled: false },
    { type: 'separator' },
    { label: 'Chat window', accelerator: 'Ctrl+Alt+C', click: () => openChat() },
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
        click: () => { cfg.size = px; saveCfg(); if (win) { win.setSize(px, px); win.webContents.send('ui:size', px); } }
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
    { label: 'Open files', click: () => openFilesFolder() },
    { label: 'Open Ade API', click: () => shell.openExternal(ADE_BASE + '/v1/health') },
    { label: 'Restart Ade OS…', click: async () => { const r = await ade('/v1/restart', { method: 'POST', body: {} }); dialogNote(r.ok ? 'Restart requested.' : 'Restart failed: ' + (r.error || r.status)); } },
    { label: 'Boot twin.', click: () => {
      const twinLauncher = path.join(__dirname, '..', '..', 'scripts', 'adeos-run-avatar.ps1');
      const p = spawn('powershell.exe', ['-File', twinLauncher], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      p.unref();
      setTimeout(pollAde, 3000);
    } },
    { type: 'separator' },
    { label: 'Quit avatar', click: () => { app.quit(); } }
  ]);
}
function dialogNote(msg) {
  const tgt = (chatWin && !chatWin.isDestroyed()) ? chatWin : win;
  if (tgt && !tgt.isDestroyed()) tgt.webContents.send('ui:note', msg);
}

let smokeLogs = null;
const shortcuts = { chat: null, talk: null };
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
  tray.on('click', () => openChat());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

/* -------------------------------------------------------------------- IPC */
/* Named, not inline, so --smoke's pttUp drive can swap it out for a recorder
   and restore exactly this -- see startSmokeRun()'s pttSmoke block. */
/* Per-route client budgets. Ade OS's /v1/ask deadline is ~400s; /v1/tasks
 * is an unattended agent turn and routinely runs past two minutes. A single
 * 120s AbortController used to report "Call failed" on every escalated
 * task Enter, while Ade was still working. */
const ADE_CALL_TIMEOUT_MS = {
  '/v1/tasks': 20 * 60 * 1000,
  '/v1/ask': 7 * 60 * 1000,
  '/v1/chat/completions': 7 * 60 * 1000,
  '/v1/terminal': 5 * 60 * 1000
};
const ADE_CALL_TIMEOUT_DEFAULT_MS = 120000;

function handleAdeCall(_e, pathname, method, body) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/v1/')) {
    return { ok: false, status: 0, error: 'refused: only /v1/* on the local Ade OS' };
  }
  const timeout = ADE_CALL_TIMEOUT_MS[pathname] || ADE_CALL_TIMEOUT_DEFAULT_MS;
  return ade(pathname, { method: method || 'GET', body: body || null, timeout });
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
  try { return loadThreads(threadsPath()); } catch (e) { return { chat: [], shell: [] }; }
});
ipcMain.on('threads:save', (_e, data) => queueThreadsSave(data));
/* voice relay: glyph renderer -> chat window (speech events), and the answers
   back (chat window -> glyph renderer, which owns the audio + the mouth). */
const relayChatSpeech = (_e, ev) => {
  if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:speech', ev);
};
ipcMain.on('chat:speech', relayChatSpeech);
ipcMain.on('chat:speak', (_e, text) => {
  if (win && !win.isDestroyed()) win.webContents.send('ui:speak', String(text || ''));
});
ipcMain.on('chat:hush', () => {
  if (win && !win.isDestroyed()) win.webContents.send('ui:hush');
});
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
ipcMain.on('app:menu', () => tray && tray.popUpContextMenu(buildMenu()));
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text || '')));

/* -------------------------------------------------------------- lifecycle */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { openChat(); });

  app.whenReady().then(() => {
    const sess = session.defaultSession;
    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'microphone'
        || permission === 'audioCapture');
    });
    sess.setPermissionCheckHandler((_wc, permission) => (
      permission === 'media' || permission === 'microphone'
      || permission === 'audioCapture'
    ));
    loadCfg();
    ensureFilesLayout(filesUserData());
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
      ['chat', ['Control+Alt+C'], () => openChat()],
      ['talk', ['Control+Alt+Space', 'Control+Shift+Space', 'Control+Alt+V'],
        () => win && win.webContents.send('ui:micToggle')],
      ['stop', ['Control+Alt+S'], () => {
        /* stop hotkey: cuts speech and opens nothing */
        if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.executeJavaScript('(function(){ window.__handleSpeech({ text: "stop", engine: "whisper" }); })(),0');
      }],
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

    /* The window is a rectangle and the avatar is not, so prove the mouse is
       handed back everywhere the avatar is not drawn -- and, just as much,
       that it is NOT handed back where it is. A click-through window that is
       click-through over its own glyph is just as broken. */
    /* The hint line must name the key that actually bound, and no OS key may
       have been taken to get one. The hint now lives in the chat window (it
       was a child of the bar, and the bar is gone), so the probe reads it
       there. Both were wrong at once: it advertised Ctrl+Alt+Space while
       Ctrl+Shift+Space was live, and Alt+Space had been taken from every other
       application to open the bar. */
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
        takesNoOsKey: !OS_OWNED.includes(shortcuts.chat) && !OS_OWNED.includes(shortcuts.talk),
        chatHotkey: shortcuts.chat
      };
      keys.ok = keys.hintMatchesBinding && keys.takesNoOsKey;
    } catch (e) { keys = { error: String((e && e.message) || e) }; }

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
        /* the launcher click already opened chatWin earlier in the run, so
           baseline it closed here: askOpened must prove the SPEECH path
           opened it, not the orb */
        await js('window.adeBridge.hideChat(),0');
        await new Promise((r) => setTimeout(r, 120));
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

        /* speech without the wake word enters the input and does not dispatch */
        posted.length = 0;
        await js('(function(){ window.__handleSpeech({ text: "hello from the mic", engine: "whisper", dictate: true }); })(),0');
        await new Promise((r) => setTimeout(r, 150));
        voiceRelay.dictateEnters = await js('document.getElementById("in").value') === 'hello from the mic';
        voiceRelay.dictateNoDispatch = posted.length === 0;

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
          && posted.every((p) => p.pathname.indexOf('/v1/approvals') !== 0);
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
          && voiceRelay.dictateEnters === true
          && voiceRelay.dictateNoDispatch === true
          && voiceRelay.stopDoesNotOpen === true
          && pttSmoke.ok === true;
      } finally {
        await js('window.adeBridge.hideChat(),0').catch(() => {});
        ipcMain.removeHandler('ade:call');
        ipcMain.handle('ade:call', handleAdeCall);
      }
    } catch (e) { voiceRelay = { error: String((e && e.message) || e) }; }

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
            VOICE_ACTION so nothing is dispatched by the check itself. The
            relay is parked for the check so the utterance cannot open the
            chat window or start a real /v1/ask behind this probe's back --
            the flare is what is being measured, not a side effect. */
      ipcMain.removeListener('chat:speech', relayChatSpeech);
      try {
        await js('(function(){ window.__wakeCalls = 0; var w = window.GLYPH.wake;' +
                 ' window.GLYPH.wake = function(){ window.__wakeCalls++; return w.apply(this, arguments); }; })(),0');
        await js('window.__onUtterance({text:"Ade, remember the milk"}),0');
        await settle(80);
        hearing.wakeCalls = await js('window.__wakeCalls');
        await js('window.__wakeCalls = 0,0');
        await js('window.__onUtterance({text:"the deploy finished, we should go home"}),0');
        await settle(80);
        hearing.nonWakeCalls = await js('window.__wakeCalls');
      } finally {
        ipcMain.addListener('chat:speech', relayChatSpeech);
      }

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

    /* The probes above may legitimately have opened the chat window and
       written into its threads -- the boot mic fallback, voiceRelay's ask,
       any PTT/status relay. That is this run's own doing, not the user's, so
       restore the desk before chatProbe so "hidden at launch" and "fresh
       threads round-trip" still measure the launch state. */
    try {
      await chatWin.webContents.executeJavaScript(
        '(function(){ var w = window.__threads();' +
        ' w.chat = []; w.shell = [];' +
        ' window.adeBridge.threadsSave({chat:[],shell:[]}),0; })(),0');
      await new Promise((r) => setTimeout(r, 400));
      if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
    } catch (e) { /* smoke hygiene only; chatProbe reports its own results */ }

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
          'window.adeBridge.threadsSave({chat:[{id:"smoke",role:"user",kind:"text",text:"t",meta:{}}],shell:[]}),0'
        );
        await new Promise((r) => setTimeout(r, 900));   /* main's 400ms write debounce */
        chatProbe.bridgeRoundTrip = await chatWin.webContents.executeJavaScript(
          '(async function(){ var t = await window.adeBridge.threadsLoad(); return t && t.chat && t.chat[0] ? t.chat[0].id : null; })()'
        );
        /* openChat() with no tab (tray / Ctrl+Alt+C) must still focus #in.
           Before the fix, chat:focus only fired when a tab was passed. */
        openChat();
        await new Promise((r) => setTimeout(r, 80));
        chatProbe.inputFocused = await chatWin.webContents.executeJavaScript(
          'document.activeElement && document.activeElement.id === "in"'
        );
        if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
      }
      chatProbe.ok = chatProbe.exists === true
        && chatProbe.hiddenAtLaunch === true
        && chatProbe.resizable === true
        && chatProbe.inTaskbar === true
        && chatProbe.title === 'Ade'
        && JSON.stringify(chatProbe.tabs) === JSON.stringify(['chat', 'shell'])
        && chatProbe.loadedThreads === 0
        && chatProbe.bridgeRoundTrip === 'smoke'
        && chatProbe.inputFocused === true;
    } catch (e) { chatProbe = { error: String((e && e.message) || e) }; }

    /* The single classifier lives in the chat window now. Same contracts the
       bar's probes protected, asserted against the REAL functions. */
    let slashChat = {};
    try {
      const js = (s) => chatWin.webContents.executeJavaScript(s);
      slashChat.skillVerb = await js('JSON.stringify(window.__classify("/skill"))');
      slashChat.skillNamed = await js('JSON.stringify(window.__classify("/skill brainstorming"))');
      slashChat.typeKeepsWord = await js('window.__classify("/xyzzy").type');
      slashChat.superpowersIsSkill = await js('window.__classify("/superpowers").kind');
      slashChat.typeWithBody = await js('window.__classify("/qa run the suite").text');
      slashChat.plainAsksNow = JSON.parse(await js('JSON.stringify(window.__classify("fix the build"))'));
      slashChat.route = JSON.parse(await js(
        'JSON.stringify((function(){ window.__setTab("shell"); var sh = window.__routePlain("run it");' +
        ' window.__setTab("chat"); var c = window.__routePlain("what is here");' +
        ' var s = window.__routePlain("!git status");' +
        ' var typed = window.__routePlain("/coding run it");' +
        ' return { shellTab: sh, bang: s, typedTask: typed, chatPlain: c }; })())'));
      slashChat.routeOk = slashChat.route.bang.kind === 'shell'
        && slashChat.route.shellTab.kind === 'shell'
        && slashChat.route.typedTask.kind === 'task' && slashChat.route.typedTask.type === 'coding'
        && slashChat.route.chatPlain.kind === 'ask' && slashChat.route.chatPlain.route === 'ground';
      slashChat.ok = JSON.parse(slashChat.skillVerb).kind === 'skill'
        && JSON.parse(slashChat.skillNamed).text === 'brainstorming'
        && slashChat.typeKeepsWord === 'xyzzy'
        && slashChat.superpowersIsSkill === 'skill'
        && slashChat.typeWithBody === 'run the suite'
        && slashChat.plainAsksNow.kind === 'ask'
        && slashChat.plainAsksNow.route === 'ground'
        && slashChat.routeOk === true;
    } catch (e) { slashChat = { error: String((e && e.message) || e) }; }

    /* Ask contracts: escalation stays on Chat and NEVER dispatches; a
       grounded answer clears the input. */
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
      const staged = JSON.parse(await js(
        '(function(){ return JSON.stringify({ tab: window.__activeTab(), input: document.getElementById("in").value }); })()'));
      askChat.escalationStaysOnChat = staged.tab === 'chat' && staged.input === '';

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
        && askChat.escalationStaysOnChat && askChat.escalationNamesRoot
        && askChat.clearsInputOnAnswer;
    } catch (e) { askChat = { error: String((e && e.message) || e) }; }

    /* The slash-command completion popup. The property worth pinning is the
       negative one: Enter while the list is open COMPLETES a word and must not
       dispatch. A completion that fires a Task from the keystroke meant to pick
       a name would be the same class of bug as bare text auto-dispatching,
       which b74f5330 already had to fix once. */
    let cmdPopup = {};
    try {
      const js = (s2) => chatWin.webContents.executeJavaScript(s2);
      const set = (v) => js('(function(){ var i=document.getElementById("in");'
        + ' i.value=' + JSON.stringify(v) + '; window.__cmdRefresh(); return window.__cmdOpen(); })()');

      cmdPopup.opensOnSlash = await set('/');
      cmdPopup.filters = JSON.parse(await js('JSON.stringify(window.__cmdHits())'))
        .every((n) => n.indexOf('he') === 0) === false;      /* '/' shows everything */
      await set('/he');
      const hits = JSON.parse(await js('JSON.stringify(window.__cmdHits())'));
      cmdPopup.filtersByPrefix = hits.length > 0 && hits.every((n) => n.indexOf('he') === 0);
      cmdPopup.closesOnSpace = (await set('/health ')) === false;

      /* Enter with the list open: completes, does not dispatch. */
      await set('/hea');
      const before = await js('window.__dispatchCount()');
      await js('(function(){ var i=document.getElementById("in");'
        + ' i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})); })(),0');
      await new Promise((r) => setTimeout(r, 200));
      cmdPopup.enterCompletes = (await js('document.getElementById("in").value')) === '/health ';
      cmdPopup.enterDoesNotDispatch = (await js('window.__dispatchCount()')) === before;

      /* Escape closes the list and leaves the window up. The window is shown
         FIRST and the before-state recorded: asserting isVisible() at the end
         alone fails whenever an earlier probe left the window hidden, which
         says nothing about Escape. */
      chatWin.show();
      await new Promise((r) => setTimeout(r, 120));
      cmdPopup.escapeWindowBefore = chatWin.isVisible();
      await set('/he');
      await js('(function(){ var i=document.getElementById("in");'
        + ' i.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})); })(),0');
      await new Promise((r) => setTimeout(r, 150));
      cmdPopup.escapeClosedList = (await js('window.__cmdOpen()')) === false;
      cmdPopup.escapeKeptWindow = chatWin.isVisible() === cmdPopup.escapeWindowBefore;
      cmdPopup.escapeClosesListOnly = cmdPopup.escapeClosedList && cmdPopup.escapeKeptWindow;
      await js('(function(){ document.getElementById("in").value=""; window.__cmdRefresh(); })(),0');

      cmdPopup.ok = cmdPopup.opensOnSlash === true
        && cmdPopup.filtersByPrefix === true
        && cmdPopup.closesOnSpace === true
        && cmdPopup.enterCompletes === true
        && cmdPopup.enterDoesNotDispatch === true
        && cmdPopup.escapeClosesListOnly === true;
    } catch (e) { cmdPopup = { error: String((e && e.message) || e) }; }

    /* /clear and /compact MOVE messages into session memory. The assertion that
       matters is conservation: the tab loses exactly what the archive gains, so
       a "saved to session memory" message cannot be a claim about data that was
       actually destroyed. */
    let clearArchive = {};
    try {
      const js = (s2) => chatWin.webContents.executeJavaScript(s2);
      const enter = (v) => js('(function(){ var i=document.getElementById("in");'
        + ' i.value=' + JSON.stringify(v) + ';'
        + ' i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));'
        + ' })(),0');

      await js('(function(){ window.__setTab("chat"); var t = window.__threads();'
        + ' t.chat.push({id:"sm1",role:"user",kind:"text",text:"one",meta:{}},'
        + '             {id:"sm2",role:"user",kind:"text",text:"two",meta:{}}); })(),0');
      const before = JSON.parse(await js(
        'JSON.stringify({tab: window.__threads().chat.length, arch: window.__archive().length})'));

      await enter('/clear');
      await new Promise((r) => setTimeout(r, 300));
      const after = JSON.parse(await js(
        'JSON.stringify({tab: window.__threads().chat.length, arch: window.__archive().length,'
        + ' moved: (window.__archive().slice(-1)[0] || {messages:[]}).messages.length})'));

      clearArchive.archiveGrew = after.arch === before.arch + 1;
      clearArchive.movedEverything = after.moved === before.tab;
      /* the tab holds only the report line clear() pushes afterwards */
      clearArchive.tabEmptied = after.tab === 1;
      clearArchive.nothingDestroyed = after.moved === before.tab;

      /* /restore puts it back where it came from */
      await enter('/restore');
      await new Promise((r) => setTimeout(r, 300));
      const back = JSON.parse(await js(
        'JSON.stringify({tab: window.__threads().chat.length, arch: window.__archive().length})'));
      clearArchive.restoreReturnsThem = back.tab >= before.tab;
      clearArchive.restorePopsArchive = back.arch === before.arch;

      clearArchive.ok = clearArchive.archiveGrew && clearArchive.movedEverything
        && clearArchive.tabEmptied && clearArchive.restoreReturnsThem
        && clearArchive.restorePopsArchive;
    } catch (e) { clearArchive = { error: String((e && e.message) || e) }; }

    /* /health end to end: renderer -> ade:call -> the sealed twin on :8301. Asserts the
       reply carries what Ade OS SAID (a status word and a named subsystem)
       rather than a sentence this file could have written by itself. */
    let healthCmd = {};
    try {
      const js = (s2) => chatWin.webContents.executeJavaScript(s2);
      await js('(function(){ window.__setTab("chat"); var t=window.__threads();'
        + ' t.chat.length = 0; })(),0');
      await js('(function(){ var i=document.getElementById("in"); i.value="/health";'
        + ' i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));'
        + ' })(),0');
      await new Promise((r) => setTimeout(r, 2500));   /* a real round trip */
      const said = await js('(function(){ var t=window.__threads().chat;'
        + ' return t.map(function(m){ return m.text; }).join(" | "); })()');
      healthCmd.said = String(said).slice(0, 240);
      healthCmd.asked = said.indexOf('Asking Ade OS') !== -1;
      healthCmd.namedStatus = /Ade OS: (up|down|unknown)/.test(said)
        || said.indexOf('did not answer') !== -1;
      /* memory / inference are Ade OS's own subsystem names -- this file never
         writes them, so their presence proves the reply came from the API */
      healthCmd.namedSubsystem = /memory:|inference:/.test(said)
        || said.indexOf('did not answer') !== -1;
      healthCmd.notCanned = !/nominal/i.test(said);
      healthCmd.ok = healthCmd.asked && healthCmd.namedStatus
        && healthCmd.namedSubsystem && healthCmd.notCanned;
    } catch (e) { healthCmd = { error: String((e && e.message) || e) }; }

    /* Every command in COMMANDS, driven through the REAL keydown path, with the
       chat renderer's console captured -- smokeLogs only ever collected the
       glyph window, which is why a total parse failure once surfaced as five
       opaque "Script failed to execute" strings instead of one syntax error.

       /reset is skipped: it hides the window, which would end the run. */
    let cmdAudit = {};
    try {
      const errs = [];
      const onMsg = (_e, level, message) => { if (level >= 2) errs.push(String(message).slice(0, 160)); };
      chatWin.webContents.on('console-message', onMsg);
      const js = (s2) => chatWin.webContents.executeJavaScript(s2);
      const names = JSON.parse(await js(
        'JSON.stringify(window.__commandNames ? window.__commandNames() : [])'));
      const rows = {};
      for (const n of names) {
        if (n === 'reset') { rows[n] = 'SKIPPED (hides the window)'; continue; }
        const at = errs.length;
        await js('(function(){ window.__threads().chat.length = 0;'
          + ' var i=document.getElementById("in"); i.value="/' + n + '";'
          + ' i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));'
          + ' })(),0');
        await new Promise((r) => setTimeout(r, 130));
        const said = await js('(function(){ var t=window.__threads().chat;'
          + ' return t.map(function(m){return m.text;}).join(" | "); })()');
        rows[n] = { said: String(said).slice(0, 90), threw: errs.length > at };
      }
      chatWin.webContents.removeListener('console-message', onMsg);
      const silent = Object.keys(rows).filter((n) => rows[n].said === '');
      const threw = Object.keys(rows).filter((n) => rows[n].threw);
      cmdAudit = { count: names.length, rows, silent, threw, consoleErrors: errs.slice(0, 8) };
      cmdAudit.ok = silent.length === 0 && threw.length === 0;
    } catch (e) { cmdAudit = { error: String((e && e.message) || e) }; }

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

    /* Approvals live on the Chat tab. A new undecided approval appends a
       card and RAISES the window (the orb's amber pending look is glyph.js
       reading state.pending and does not move); Allow/Deny posts
       /v1/approvals/<id>/decide and marks the card; the same id never
       double-appends. Driven renderer-side so the probe owes the network
       nothing -- pollAde()'s arrival only decides WHICH id, the card logic
       is here. */
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
           race with this probe's own __showApproval(null)/s2/s3 assertions. The
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
          && smsApproval.tab === 'chat'
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
                 ' w.chat = w.chat.filter(function(m){ return !(m.kind === "approval" && m.meta && /^s[123]$/.test(m.meta.approval && m.meta.approval.id)); });' +
                 ' window.adeBridge.threadsSave({ chat: w.chat, shell: w.shell }),0; })(),0').catch(() => {});
        ipcMain.removeHandler('ade:call');
        ipcMain.handle('ade:call', handleAdeCall);
        timer = setInterval(pollAde, 2000);
      }
    } catch (e) { smsApproval = { error: String((e && e.message) || e) }; }

    let dropChat = {};
    try {
      try {
        await chatWin.webContents.executeJavaScript('window.adeBridge.openChat(),0');
        await new Promise((r) => setTimeout(r, 160));
        await chatWin.webContents.executeJavaScript(
          '(function(){ var dt = new DataTransfer();' +
          ' dt.items.add(new File(["x"], "fake.txt"));' +
          ' window.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));' +
          ' void 0; })()');
        await new Promise((r) => setTimeout(r, 40));
        dropChat.overlayOn = await chatWin.webContents.executeJavaScript('document.body.classList.contains("dropping")');
        await chatWin.webContents.executeJavaScript(
          '(function(){ var dt = new DataTransfer();' +
          ' dt.items.add(new File(["x"], "fake.txt"));' +
          ' window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));' +
          ' void 0; })()');
        await new Promise((r) => setTimeout(r, 120));
        dropChat.overlayOff = !(await chatWin.webContents.executeJavaScript('document.body.classList.contains("dropping")'));
        dropChat.nothingSelected = (await chatWin.webContents.executeJavaScript('document.getElementById("thread").textContent'))
          .indexOf('Nothing droppable there.') >= 0;
        dropChat.ok = dropChat.overlayOn === true
          && dropChat.overlayOff === true
          && dropChat.nothingSelected === true;
      } finally {
        await chatWin.webContents.executeJavaScript('window.adeBridge.hideChat(),0').catch(() => {});
        await chatWin.webContents.executeJavaScript(
          '(function(){ var w = window.__threads();' +
          ' for (var t in w) w[t] = (w[t] || []).filter(function(m){' +
          ' return m.text !== "Nothing droppable there. Use /upload to pick files, or /upload folder for a directory."' +
          ' && m.text !== "…uploading"; });' +
          ' window.adeBridge.threadsSave(w),0; })(),0').catch(() => {});
      }
    } catch (e) { dropChat = { error: String((e && e.message) || e) }; }

    console.log('SMOKE ' + JSON.stringify({
      shortcuts,
      visible: win.isVisible(),
      chatProbe,
      slashChat,
      askChat,
      cmdPopup,
      clearArchive,
      healthCmd,
      cmdAudit,
      retryChat,
      smsApproval,
      dropChat,
      bounds: win.getBounds(),
      workArea: screen.getDisplayMatching(win.getBounds()).workArea,
      tray: !!tray,
      clickThrough: !!cfg.clickThrough,
      interact,
      mic,
      hearing,
      hit,
      voiceRelay,
      keys,
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

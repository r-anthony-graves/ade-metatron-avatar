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

const ADE_BASE = process.env.ADEOS_URL || 'http://127.0.0.1:8300';
const SMOKE = process.argv.includes('--smoke');
const BAR_H = 108;                       /* the command bar lives under the glyph */
const CFG_PATH = () => path.join(app.getPath('userData'), 'avatar-state.json');

let win = null, tray = null, timer = null, dragAnchor = null;
let overPaint = false, barOpen = false, lastIgnore = null;
let cfg = { x: null, y: null, size: 380, clickThrough: false, speak: false, opacity: 1, backing: true, mic: true };
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

/* ------------------------------------------------------------------ tray */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: state.online ? `Ade OS: ${state.pending ? state.pending + ' awaiting approval' : (state.busy ? 'working' : 'idle')}` : 'Ade OS: offline', enabled: false },
    { label: state.brain ? '  ' + state.brain : '  (no brain reported)', enabled: false },
    { type: 'separator' },
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
});
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
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    loadCfg();
    createWindow();
    createTray();
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

    /* `/word` must reach a ROUTE, not a dead end. Ray, 2026-08-27, trying to
       use skills from the bar: "nothing happens, it says Nothing to send".
       classify() demanded `\s+([\s\S]+)` after the type, so a lone `/word`
       came back with text:'' and send() refused it -- while the hint line was
       advertising `/type` as the way to do exactly that.

       Asserted against the REAL classify(), and falsifiable: put the `+` back
       and skillVerb/typeKeepsWord go wrong. */
    let slash = {};
    try {
      const js = (s) => win.webContents.executeJavaScript(s);
      slash.skillVerb = await js('JSON.stringify(window.__classify("/skill"))');
      slash.skillNamed = await js('JSON.stringify(window.__classify("/skill brainstorming"))');
      slash.typeKeepsWord = await js('window.__classify("/superpowers").type');
      slash.typeWithBody = await js('window.__classify("/qa run the suite").text');
      slash.plainStaysTask = await js('window.__classify("fix the build").type');
      slash.ok = JSON.parse(slash.skillVerb).kind === 'skill'
              && JSON.parse(slash.skillNamed).text === 'brainstorming'
              && slash.typeKeepsWord === 'superpowers'
              && slash.typeWithBody === 'run the suite'
              && slash.plainStaysTask === 'coding';
    } catch (e) { slash = { error: String((e && e.message) || e) }; }

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

    console.log('SMOKE ' + JSON.stringify({
      shortcuts,
      visible: win.isVisible(),
      bounds: win.getBounds(),
      workArea: screen.getDisplayMatching(win.getBounds()).workArea,
      tray: !!tray,
      clickThrough: !!cfg.clickThrough,
      interact,
      mic,
      hit,
      voice,
      keys,
      slash,
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

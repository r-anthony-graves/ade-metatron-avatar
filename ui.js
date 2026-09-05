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

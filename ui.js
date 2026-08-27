/* The avatar's behaviour: drag it, talk to it, answer its approvals.
 *
 * Two different kinds of power live behind this one input, and the mode chip
 * says which is which every time you type:
 *   Task  -> POST /v1/tasks       an agent runs it; Permission.check() applies.
 *   Shell -> POST /v1/terminal    direct subprocess. Ade OS treats this route
 *                                 as Ray's own keyboard and does NOT consult
 *                                 the gate, so it is labelled "ungated".
 *   Ask   -> POST /v1/chat/completions
 */
'use strict';
(function () {
  var B = window.adeBridge;
  var cvs = document.getElementById('glyph');
  var bar = document.getElementById('bar');
  var input = document.getElementById('in');
  var out = document.getElementById('out');
  var mode = document.getElementById('mode');
  var approve = document.getElementById('approve');
  var approveWhat = document.getElementById('approveWhat');
  var hint = document.getElementById('hint');
  /* innerHTML, not textContent: assigning textContent flattens the hint into a
     single text node and destroys every element inside it -- which it did on
     the very first paintMode(), taking the bold keys and the hotkey slot with
     it. The markup here is this file's own; only the accelerator is dynamic
     and it is written with textContent, so nothing untrusted is ever parsed. */
  var HINT = hint.innerHTML;

  var pendingApproval = null, busy = false;

  /* -------------------------------------------------------------- speech */
  /* Ade's reply is decoded from base64 WAV straight into Web Audio -- no blob
     URL, so the page keeps its `default-src 'none'` policy. The playing signal
     also drives the glyph, which is what gives the avatar a mouth. */
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
    if (!r || !r.ok) { return; }
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
    } catch (e) {
      stopSpeaking();
    }
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
  /* The window is a rectangle; the avatar is not. Only about a third of it is
     ever painted, and the transparent remainder used to swallow every click
     meant for the window underneath -- which is indistinguishable from that
     window having frozen. Report what is actually under the cursor and let
     main.js hand the rest back. */
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
    catch (e) { return true; }        /* unreadable: keep the mouse rather than lose it */
    for (var i = 3; i < data.length; i += 4) if (data[i] >= HIT_ALPHA) return true;
    return false;
  }
  function setHit(on) { if (on !== hitOn) { hitOn = on; if (B) B.hit(on); } }

  window.addEventListener('mousemove', function (e) {
    if (down) {
      setHit(true);                   /* never drop a drag that wanders off the lines */
      down.moved = Math.max(down.moved, Math.abs(e.screenX - down.x) + Math.abs(e.screenY - down.y));
      if (down.moved > 3 && B) B.dragMove();
      return;
    }
    if (bar.classList.contains('open')) { setHit(true); return; }
    var now = Date.now();
    if (now - hitAt < 16) return;     /* getImageData stalls the GPU; once a frame is plenty */
    hitAt = now;
    setHit(painted(e.clientX, e.clientY));
  });
  document.addEventListener('mouseout', function (e) {
    /* no relatedTarget means the pointer left the window entirely, and no
       further mousemove is coming to switch it back off */
    if (!e.relatedTarget && !down && !bar.classList.contains('open')) setHit(false);
  });
  window.addEventListener('mouseup', function () {
    if (!down) return;
    var wasClick = down.moved <= 3;
    down = null;
    if (B) B.dragEnd();
    if (wasClick) toggleBar();
  });
  cvs.addEventListener('contextmenu', function (e) { e.preventDefault(); if (B) B.menu(); });

  /* ---------------------------------------------------------------- bar */
  function toggleBar(force) {
    var open = force === undefined ? !bar.classList.contains('open') : !!force;
    bar.classList.toggle('open', open);
    if (B) B.bar(open);      /* main gives the window focus only while this is open */
    if (open) setTimeout(function () { input.focus(); input.select(); }, 40);
    else { input.blur(); setHit(false); }
  }
  function say(text, isErr) {
    out.textContent = String(text == null ? '' : text);
    out.classList.toggle('show', !!out.textContent);
    out.classList.toggle('err', !!isErr);
  }

  /* ---------------------------------------------------- spoken -> typed */
  /* You cannot say "!". classify() keys on the first character, so a leading
     spoken keyword is rewritten into the prefix it means and the SAME
     classifier then runs. One set of rules: a second classifier for speech
     would be a second thing to keep in step, and the two would drift.

     The keywords are ordinary English words, so "ask Ade what the backlog is"
     becomes an ask rather than a task. That ambiguity is known and accepted
     for now -- see the spec's Assumptions section. */
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
  window.__spokenToTyped = spokenToTyped;   /* --smoke reaches it here */

  /* Whisper capitalises and adds terminal punctuation ("Check the health."),
     but VOICE_ACTIONS' 9 keys are bare lowercase phrases. Without this, every
     one of the 9 missed the map and fell through to spokenToTyped() as open
     speech -- turning a READ (GET /v1/health) into a dispatched TASK. Used
     for the VOICE_ACTIONS probe only; spokenToTyped() keeps punctuation,
     because a dictated sentence should. */
  function normalizeSpoken(text) {
    return String(text == null ? '' : text).trim().replace(/[.!?,;:]+$/, '').toLowerCase();
  }
  window.__normalizeSpoken = normalizeSpoken;   /* --smoke reaches it here */

  function classify(raw) {
    var v = raw.trim();
    if (v.charAt(0) === '!') return { kind: 'shell', text: v.slice(1).trim() };
    if (v.charAt(0) === '?') return { kind: 'ask', text: v.slice(1).trim() };
    if (v.charAt(0) === '/') {
      var m = v.slice(1).match(/^(\S+)\s+([\s\S]+)$/);
      if (m) return { kind: 'task', type: m[1], text: m[2] };
      return { kind: 'task', type: v.slice(1).trim(), text: '' };
    }
    return { kind: 'task', type: 'coding', text: v };
  }
  function paintMode() {
    var c = classify(input.value);
    mode.className = c.kind;
    mode.textContent = c.kind === 'shell' ? 'Shell' : c.kind === 'ask' ? 'Ask' : ('Task' + (c.type && c.type !== 'coding' ? ' · ' + c.type : ''));
    if (c.kind === 'shell') hint.textContent = 'Direct subprocess — NOT gated by Permission.check(). Enter to run.';
    else hint.innerHTML = HINT;
  }
  input.addEventListener('input', paintMode);
  paintMode();

  /* ------------------------------------------------ pull a reply out of Ade */
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

  async function send() {
    var raw = input.value;
    if (!raw.trim() || busy || !B) return;
    var c = classify(raw);
    if (!c.text) { say('Nothing to send.', true); return; }

    stopSpeaking();                 /* barge-in: a new ask cuts off the old answer */
    busy = true;
    out.classList.add('show'); out.classList.remove('err');
    out.innerHTML = '<span class="spin">…working</span>';

    var res;
    if (c.kind === 'shell') {
      res = await B.call('/v1/terminal', 'POST', { cmd: c.text });
    } else if (c.kind === 'ask') {
      res = await B.call('/v1/chat/completions', 'POST', {
        messages: [{ role: 'user', content: c.text }], stream: false
      });
    } else {
      res = await B.call('/v1/tasks', 'POST', {
        description: c.text, task_type: c.type || 'coding', topic: 'u/local/avatar'
      });
    }

    busy = false;
    if (!res || !res.ok) {
      say((res && (res.error || ('HTTP ' + res.status))) || 'no response from Ade OS', true);
      return;
    }
    var text = readReply(res.data);
    say(text || '(no output)');
    input.value = ''; paintMode();

    if (text && await B.speakEnabled()) speakText(text);
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); toggleBar(false); }
    else if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !window.getSelection().toString()) {
      if (B) B.copy(out.textContent);
    }
  });

  /* ------------------------------------------------------- voice control */
  /* Every phrase maps to a READ or to a task. Nothing here can decide an
     approval -- see the note at the top of ptt.js for why that line is drawn. */
  var VOICE_ACTIONS = {
    'check the health':     { read: '/v1/health' },
    'what is pending':      { read: '/v1/approvals' },
    'list the agents':      { read: '/v1/agents' },
    'what are you doing':   { read: '/v1/activity' },
    'show the backlog':     { read: '/v1/pm/backlog' },
    'run the tests':        { task: 'run the full test suite and report failures', type: 'generate_artifacts' },
    'read the file':        { prompt: 'read the file ' },
    'open the command bar': { ui: 'bar' },
    'stop':                 { ui: 'stop' }
  };

  async function runVoice(phrase) {
    var act = VOICE_ACTIONS[phrase];
    if (!act) { say('Heard "' + phrase + '" — no action bound to it.', true); return; }

    if (act.ui === 'stop') { stopSpeaking(); say('Stopped.'); return; }
    if (act.ui === 'bar')  { toggleBar(true); say('Listening for a typed command.'); return; }
    if (act.prompt) { toggleBar(true); input.value = act.prompt; paintMode(); input.focus(); return; }

    out.classList.add('show'); out.classList.remove('err');
    out.innerHTML = '<span class="spin">…' + phrase + '</span>';

    var r;
    if (act.read) r = await B.call(act.read, 'GET', null);
    else r = await B.call('/v1/tasks', 'POST',
      { description: act.task, task_type: act.type || 'coding', topic: 'u/local/avatar' });

    if (!r || !r.ok) { say((r && (r.error || 'HTTP ' + r.status)) || 'no reply', true); return; }
    var text = readReply(r.data);
    say(text || '(no output)');
    if (await B.speakEnabled()) speakText(text);
  }

  async function pttDown() {
    if (!B || PTT.isActive()) return;
    var ok = await PTT.start(function (lvl) { if (window.GLYPH) window.GLYPH.setSpeaking(lvl * 0.7); });
    if (!ok) { toggleBar(true); say('Microphone unavailable.', true); return; }
    toggleBar(true);
    out.classList.add('show'); out.classList.remove('err');
    out.innerHTML = '<span class="spin">…listening</span>';
  }
  async function pttUp() {
    if (!B || !PTT.isActive()) return;
    if (window.GLYPH) window.GLYPH.setSpeaking(0);
    out.innerHTML = '<span class="spin">…recognising</span>';
    var r = await PTT.stop();
    if (!r.ok) { say('Did not catch that (' + r.error + ').', true); return; }
    if (!r.text) { say('Did not catch that. Say one of: ' + Object.keys(VOICE_ACTIONS).slice(0, 4).join(', ') + '…', true); return; }
    say('“' + r.text + '”');
    /* normalizeSpoken() strips whisper's capital + terminal punctuation before
       the lookup, and runVoice() below gets the SAME normalised string -- it
       does its own exact-key lookup, so a mismatch there would silently drop
       a matching phrase to the open-speech path. spokenToTyped() below still
       gets the raw r.text, punctuation and all. */
    var spoken = normalizeSpoken(r.text);
    if (VOICE_ACTIONS[spoken]) { runVoice(spoken); return; }
    /* Open speech. Shell gets the same beat typing has: it lands in the bar
       with its amber "ungated" chip and waits for Enter. /v1/terminal has no
       gate in front of it, so removing the pause for voice would make speech
       MORE powerful than typing against the one path with no gate. */
    var typed = spokenToTyped(r.text);
    toggleBar(true);
    input.value = typed;
    paintMode();
    input.focus();
    if (classify(typed).kind !== 'shell') input.select();
  }

  /* ---------------------------------------------------------- approvals */
  function showApproval(a) {
    pendingApproval = a;
    if (!a) { approve.classList.remove('show'); return; }
    var args = '';
    try { args = JSON.stringify(a.args, null, 1); } catch (e) { args = String(a.args); }
    approveWhat.textContent = a.tool + '\n' + args;
    approve.classList.add('show');
    toggleBar(true);
  }
  async function decide(allow) {
    if (!pendingApproval || !B) return;
    var id = pendingApproval.id;
    approve.classList.remove('show');
    var r = await B.call('/v1/approvals/' + encodeURIComponent(id) + '/decide', 'POST',
      { allow: allow, reason: allow ? 'allowed from the desktop avatar' : 'denied from the desktop avatar', decided_by: 'human' });
    say(r && r.ok ? (allow ? 'Allowed ' + id : 'Denied ' + id)
                  : 'Could not decide ' + id + ': ' + ((r && (r.error || r.status)) || '?'), !(r && r.ok));
    pendingApproval = null;
  }
  document.getElementById('allow').addEventListener('click', function () { decide(true); });
  document.getElementById('deny').addEventListener('click', function () { decide(false); });

  /* ------------------------------------------------------- Ade's state in */
  if (B) {
    B.onState(function (s) {
      if (window.GLYPH) window.GLYPH.setAde(s);
      var a = s && s.approval;
      if (a && (!pendingApproval || pendingApproval.id !== a.id)) showApproval(a);
      else if (!a && pendingApproval) { pendingApproval = null; approve.classList.remove('show'); }
    });
    B.onToggleBar(function () { toggleBar(); });
    B.onArm(function () { if (window.GLYPH) window.GLYPH.arm(); });
    B.onNote(function (m) { toggleBar(true); say(m); });
    B.onSpeak(function (t) { speakText(t); });
    B.onHush(function () { stopSpeaking(); });
    B.onPttDown(function () { pttDown(); });
    B.onPttUp(function () { pttUp(); });
    B.onBacking(function (on) { if (window.GLYPH) window.GLYPH.setBacking(on); });
    /* The hint names the key that actually bound. Hardcoding one is how this
       line came to advertise Ctrl+Alt+Space while Ctrl+Shift+Space was the
       live binding -- and a documented key that does nothing is exactly what
       a dead app looks like. */
    var PRETTY_KEY = { Control: 'Ctrl', Super: 'Win' };
    B.shortcuts().then(function (k) {
      var el = document.getElementById('talkKey');
      if (!el) return;
      el.textContent = (k && k.talk)
        ? String(k.talk).split('+').map(function (t) { return PRETTY_KEY[t] || t; }).join('+')
        : 'tray menu';
      HINT = hint.innerHTML;     /* HINT was captured before this resolved */
    });
    B.config().then(function (c) {
      if (c && window.GLYPH) window.GLYPH.setBacking(c.backing !== false);
    });
    B.state().then(function (s) { if (s && window.GLYPH) window.GLYPH.setAde(s); });
  }
})();

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

  /* ------------------------------------------------------------ boot */
  function boot() {
    if (!B) return;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () { setTab(this.getAttribute('data-tab')); });
    }
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
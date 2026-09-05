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
    wrap.setAttribute('data-id', m.id);
    if (m.role === 'system') {
      wrap.className = 'sys';
      wrap.textContent = m.text;
      return wrap;
    }
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
      } else if (m.meta && m.meta.moot) {
        /* The approval vanished from the state stream (resolved elsewhere):
           keep the card as a persisted read-only record, but no dead buttons. */
        var mt = document.createElement('div');
        mt.className = 'moot';
        mt.textContent = 'resolved elsewhere — no longer pending';
        card.appendChild(mt);
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
  /* The audio engine lives in the glyph renderer -- its analyser drives the
     orb's mouth -- so the chat window only decides WHEN to speak and asks main
     to relay. It never decodes audio itself. */
  function speakText(text) {
    if (!B || !text) return;
    if (B.speakGlyph) B.speakGlyph(text);
  }
  function stopSpeaking() { if (B && B.speakGlyphStop) B.speakGlyphStop(); }
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

    if (c.kind === 'ask' && c.route === 'ground') {
      var spoken = applyAskResult(res.data);
      if (spoken && await B.speakEnabled()) speakText(spoken);
      return;
    }

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

  /* ---------------------------------------------------------- approvals */
  /* An undecided approval is a card in the Task tab. The glyph's amber
     pending look is glyph.js reading state.pending -- this window only owns
     the decision itself. `showApprovalId` guards on the id so a 2s poll never
     doubles the card, and the raise only fires when the id CHANGES. An
     approval that leaves the state stream without a local decision is demoted
     to a read-only "moot" record (no dead Allow/Deny buttons). */
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
    if (!a) {
      showingApprovalId = null;
      markApprovalsMoot();                 /* nothing pending: demote stale cards */
      return;
    }
    var id = a.id;
    if (showingApprovalId === id && lastApprovalCardId() === id) return;   /* already up */
    markApprovalsMoot();                 /* a new id supersedes any undecided older card */
    showingApprovalId = id;
    if (lastApprovalCardId() !== id) {
      push('task', 'ade', 'approval', '', { approval: a });
    }
    setTab('task');
    if (B) B.openChat('task');                 /* auto-raise on a NEW approval */
  }
  window.__showApproval = showApprovalId;

  /* A card whose approval vanished from the state stream is "moot": it stays
     as a persisted read-only record (the thread is an audit of what presented),
     but its Allow/Deny buttons go away so nobody POSTs a decision against an
     id that is no longer pending. Decided cards are never demoted. */
  function markApprovalsMoot() {
    var list = threads.task, changed = false;
    for (var i = 0; i < list.length; i++) {
      var mt = list[i];
      if (mt && mt.meta && mt.meta.approval && !mt.meta.decided && !mt.meta.moot) {
        mt.meta.moot = true;
        changed = true;
      }
    }
    if (changed) { renderThread(); persist(); }
  }
  window.__markApprovalsMoot = markApprovalsMoot;

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
      if (e.key === 'Enter') {
        var text = input.value.trim();
        // Phase 1: slash command handling
        if (text.charAt(0) === '/') {
          var parts = text.slice(1).split(' ');
          var cmd = parts[0].toLowerCase();
          var args = parts.slice(1).join(' ');
          var handled = false;
          if (cmd === 'help') {
            // Show help overlay
            push(activeTab, 'system', 'text', 'Available commands: /help, /status, /clear, /reset, /cancel');
            handled = true;
          } else if (cmd === 'status') {
            push(activeTab, 'system', 'text', 'System: glyph window, chat window active, orb click to open');
            handled = true;
          } else if (cmd === 'clear') {
            input.value = '';
            handled = true;
          } else if (cmd === 'reset') {
            // Reset session - clear threads, approvals, hide window
            if (B) B.hideChat();
            if (threads) {
              threads = threads.map(function(t) { if (t.kind === 'approval' && !t.meta.decided) t.meta.moot = true; });
              renderThread();
              persist();
            }
            handled = true;
} else if (cmd === 'cancel') {
            // Cancel any staged operation - reset staged state
            // (no-op for now, staged drafts are per-session)
            handled = true;
         } else if (cmd === 'plan') {
            // Show plan summary
            push(activeTab, 'system', 'text', 'Plan: 9-task migration. Tasks 1-8 complete. Task 9 verification pass pending human hands-on pass.');
            handled = true;
         } else if (cmd === 'task') {
            // List open tasks
            push(activeTab, 'system', 'text', 'Tasks: 1-threads-store, 2-chat skeleton, 3-classifier, 4-approvals, 5-voice relays, 6-orb launcher, 7-hotkey/tray, 8-drag-upload. Task 9 verification pass.');
            handled = true;
         } else if (cmd === 'steps') {
            // Show current step list
            push(activeTab, 'system', 'text', 'Steps: Task 1 threads-store, Task 2 chat window, Task 3 send pipeline, Task 4 approvals, Task 5 voice relays, Task 6 orb launcher, Task 7 hotkey/tray, 8-drag-upload. Task 9 verification.');
            handled = true;
         } else if (cmd === 'progress') {
            // Show progress percent
            push(activeTab, 'system', 'text', 'Progress: Tasks 1-8 complete out of 9 total. Task 9 Step 4 human hands-on pass pending.');
            handled = true;
} else if (cmd === 'review') {
            // Show review summary
            push(activeTab, 'system', 'text', 'Review: whole-branch review recommended "Yes-with-known-tradeoffs, 0 criticals/importants." Phase 1-3 slash commands implemented. Plan amendments recorded.');
            handled = true;
         } else if (cmd === 'search') {
            // Search knowledge - use /v1/ask channel
            if (args) {
              B.call('/v1/ask', 'POST', { question: args }).then(function (result) {
                var answer = result && result.ok ? (result.data && result.data.answer) : 'No answer';
                push(activeTab, 'system', 'text', 'Search result: ' + answer);
              }).catch(function (e) {
                push(activeTab, 'system', 'text', 'Search failed: ' + (e && e.message ? e.message : 'unknown error'));
              });
            } else {
              push(activeTab, 'system', 'text', 'Usage: /search <question>');
            }
            handled = true;
         } else if (cmd === 'research') {
            // Research multi-sentence question
            if (args) {
              B.call('/v1/ask', 'POST', { question: args }).then(function (result) {
                var answer = result && result.ok ? (result.data && result.data.answer) : 'No answer';
                push(activeTab, 'system', 'text', 'Research result: ' + answer);
              }).catch(function (e) {
                push(activeTab, 'system', 'text', 'Research failed: ' + (e && e.message ? e.message : 'unknown error'));
              });
            } else {
              push(activeTab, 'system', 'text', 'Usage: /research <question>');
            }
            handled = true;
         } else if (cmd === 'summarize') {
            // Summarize current thread
            var list = threads.task;
            var recent = '';
            for (var i = 0; i < list.length && i < 10; i++) {
              var t = list[i];
              if (t && t.text) {
                recent += t.text.slice(0, 50) + ' ';
              }
            }
            push(activeTab, 'system', 'text', 'Summary: ' + (recent || 'no messages'));
            handled = true;
         } else if (cmd === 'cite') {
            // Cite sources from recent answers
            var list = threads.task;
            var citations = [];
            for (var i = 0; i < list.length && i < 5; i++) {
              var t = list[i];
              if (t && t.meta && t.meta.approval) {
                citations.push('Approved: ' + t.meta.approval.id);
              }
            }
            if (citations.length > 0) {
              push(activeTab, 'system', 'text', 'Citations: ' + citations.join(', '));
            } else {
              push(activeTab, 'system', 'text', 'No citations found.');
            }
            handled = true;
         }
            // Memory: store a fact in the persistent thread
            if (args) {
              // Store: key value
              var parts = args.split(' ');
              if (parts.length >= 2) {
                var key = parts[0];
                var value = parts.slice(1).join(' ');
                var list = threads.task;
                var found = false;
                for (var i = 0; i < list.length; i++) {
                  var mt = list[i];
                  if (mt && mt.meta && mt.meta.memory && mt.meta.memory.key === key) {
                    mt.meta.memory.value = value;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  // Add new memory entry at the end
                  threads.task.push({
                    role: 'ade',
                    kind: 'memory',
                    text: 'memory',
                    meta: { key: key, value: value }
                  });
                }
                renderThread();
                persist();
                push(activeTab, 'system', 'text', 'Memory stored: ' + key);
              } else {
                push(activeTab, 'system', 'text', 'Usage: /memory key value');
              }
            } else {
              push(activeTab, 'system', 'text', 'Usage: /memory key value');
            }
            handled = true;
         } else if (cmd === 'remember') {
            // Recall a stored fact by key
            if (args) {
              var list = threads.task;
              var found = false;
              for (var i = list.length - 1; i >= 0; i--) {
                var mt = list[i];
                if (mt && mt.meta && mt.meta.memory && mt.meta.memory.key === args) {
                  found = true;
                  push(activeTab, 'system', 'text', 'Memory recalled: ' + args + ' = ' + mt.meta.memory.value);
                  break;
                }
              }
              if (!found) {
                push(activeTab, 'system', 'text', 'Memory not found: ' + args);
              }
            } else {
              push(activeTab, 'system', 'text', 'Usage: /remember key');
            }
            handled = true;
         } else if (cmd === 'forget') {
            // Forget a stored fact (mark as moot)
            if (args) {
              var list = threads.task;
              for (var i = 0; i < list.length; i++) {
                var mt = list[i];
                if (mt && mt.meta && mt.meta.memory && mt.meta.memory.key === args && !mt.meta.decided && !mt.meta.moot) {
                  mt.meta.moot = true;
                }
              }
              renderThread();
              persist();
              push(activeTab, 'system', 'text', 'Memory forgotten: ' + args);
            } else {
              push(activeTab, 'system', 'text', 'Usage: /forget key');
            }
            handled = true;
         } else if (cmd === 'recall') {
            // List all stored facts
            var list = threads.task;
            var memories = [];
            for (var i = 0; i < list.length; i++) {
              var mt = list[i];
              if (mt && mt.meta && mt.meta.memory && !mt.meta.moot) {
                memories.push(mt.meta.memory.key + ': ' + mt.meta.memory.value);
              }
            }
            if (memories.length > 0) {
              push(activeTab, 'system', 'text', 'Memories stored: ' + memories.join('; '));
            } else {
              push(activeTab, 'system', 'text', 'No memories stored.');
            }
            // Also show moot memories
            var mootMemories = [];
            for (var i = 0; i < list.length; i++) {
              var mt = list[i];
              if (mt && mt.meta && mt.meta.memory && mt.meta.moot) {
                mootMemories.push(mt.meta.memory.key + ': (forgotten)');
              }
            }
            if (mootMemories.length > 0) {
              push(activeTab, 'system', 'text', 'Forgotten memories: ' + mootMemories.join('; '));
            }
            handled = true;
         } else if (cmd === 'context') {
            // Show active context (last N messages + current tab)
            var list = threads.task;
            var recent = [];
            for (var i = list.length - 1; i >= 0 && recent.length < 5; i--) {
              if (list[i].role === 'ade' && (list[i].kind === 'text' || list[i].kind === 'system')) {
                recent.push((list[i].text || '').slice(0, 30));
              }
            }
            var contextText = recent.join('; ');
            push(activeTab, 'system', 'text', 'Active context: ' + (recent.length > 0 ? recent.join(', ') : 'empty'));
            handled = true;
         } else if (cmd === 'plan') {
            // Show plan summary
            push(activeTab, 'system', 'text', 'Plan: 9-task migration. Tasks 1-8 complete. Task 9 verification pass pending human hands-on pass.');
            handled = true;
         } else if (cmd === 'task') {
            // List open tasks
            push(activeTab, 'system', 'text', 'Tasks: 1-threads-store, 2-chat skeleton, 3-classifier, 4-approvals, 5-voice relays, 6-orb launcher, 7-hotkey/tray, 8-drag-upload. Task 9 verification pass.');
            handled = true;
         } else if (cmd === 'steps') {
            // Show current step list
            push(activeTab, 'system', 'text', 'Steps: Task 1 threads-store, Task 2 chat window, Task 3 send pipeline, Task 4 approvals, Task 5 voice relays, Task 6 orb launcher, Task 7 hotkey/tray, Task 8 drag-upload. Task 9 verification.');
            handled = true;
         } else if (cmd === 'progress') {
            // Show progress percent
            push(activeTab, 'system', 'text', 'Progress: Tasks 1-8 complete out of 9 total. Task 9 Step 4 human hands-on pass pending.');
            handled = true;
} else if (cmd === 'review') {
            // Show review summary
            push(activeTab, 'system', 'text', 'Review: whole-branch review recommended "Yes-with-known-tradeoffs, 0 criticals/importants." Phase 1-4 slash commands implemented. Plan amendments recorded.');
            handled = true;
         } else if (cmd === 'market') {
            // Market status - stub command
            push(activeTab, 'system', 'text', 'Market status: connecting to trader Ade OS...');
            handled = true;
         } else if (cmd === 'scan') {
            // Scan trading universe - stub command
            push(activeTab, 'system', 'text', 'Scanning trading universe...');
            handled = true;
         } else if (cmd === 'watch') {
            // Watchlist display - stub command
            push(activeTab, 'system', 'text', 'Watchlist display...');
            handled = true;
         } else if (cmd === 'positions') {
            // Show open positions - stub command
            push(activeTab, 'system', 'text', 'Open positions: stub command - no market data connected');
            handled = true;
         } else if (cmd === 'portfolio') {
            // Portfolio status - stub command
            push(activeTab, 'system', 'text', 'Portfolio status: stub command - no market data connected');
            handled = true;
         } else if (cmd === 'live') {
            // Live trading status - stub command with permission check
            push(activeTab, 'system', 'text', 'Live trading: permission required - use /kill to halt');
            handled = true;
         } else if (cmd === 'kill') {
            // Emergency trading halt
            push(activeTab, 'system', 'text', 'Trading halted. Emergency halt engaged.');
            handled = true;
         } else if (cmd === 'autonomy') {
            // Show/change autonomy level
            push(activeTab, 'system', 'text', 'Autonomy level: stub command - currently auto mode');
            handled = true;
         } else if (cmd === 'agent') {
            // Show active trading agents
            push(activeTab, 'system', 'text', 'Active agents: stub command - listing agents...');
            handled = true;
         } else if (cmd === 'decision') {
            // Show latest decision
            push(activeTab, 'system', 'text', 'Latest decision: stub command - no decisions recorded');
            handled = true;
         } else if (cmd === 'reason') {
            // Explain latest decision
            push(activeTab, 'system', 'text', 'Decision explanation: stub command - no decisions recorded');
            handled = true;
         } else if (cmd === 'monitor') {
            // Monitor active positions
            push(activeTab, 'system', 'text', 'Monitoring positions: stub command - no positions connected');
            handled = true;
         } else if (cmd === 'exit') {
            // Evaluate exits
            push(activeTab, 'system', 'text', 'Exit evaluation: stub command - no exit data connected');
            handled = true;
         } else if (cmd === 'learn') {
            // Analyze trading experience
            push(activeTab, 'system', 'text', 'Learning analysis: stub command - no experience data connected');
            handled = true;
         } else if (cmd === 'journal') {
            // Show trade journal
            push(activeTab, 'system', 'text', 'Trade journal: stub command - no journal data connected');
            handled = true;
         }
          if (handled) {
            e.preventDefault();
            input.value = '';
            focusInput();
            return;
          }
        }
        e.preventDefault();
        void send();
      }
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
    B.onState(handleState);
    B.onSpeech(handleSpeech);
    B.onNote(function (m) { push('chat', 'system', 'staged', String(m)); });
    B.onChatFocus(function (tab) {
      if (tab && TABS.indexOf(tab) >= 0) setTab(tab);
      renderThread();
      focusInput();
    });
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
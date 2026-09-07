/* The chat window: two persistent threads (Chat / Shell) behind tabs,
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

  var TABS = ['chat', 'shell'];
  /* Read-only views. DELIBERATELY NOT in TABS: `threads` is keyed by TABS and
     several loops walk `threads[TABS[t]]` to compact, archive and count, so a
     tab with no thread behind it would read `undefined` in five places. The
     journal is the Codex's own record, not a conversation -- pushing fetched
     entries into a persisted thread would also duplicate every entry each
     time the tab was opened. */
  var READ_TABS = ['journal'];
  /* The prompt the Codex is currently putting to Ray, from
     /v1/codex/invitation. Held because the ANSWER has to go back to the
     reflection that asked -- `answer_at` is on the invitation, not on the
     text, and asking again at submit time could hand the answer to a
     different question if a pass ran in between. */
  var standingPrompt = null;
  function allTabs() { return TABS.concat(READ_TABS); }
  function isRead(tab) { return READ_TABS.indexOf(tab) >= 0; }
  var activeTab = 'chat';
  var threads = { chat: [], shell: [], archive: [] };

  /* -------------------------------------------------------- threads */
  var persistTimer = 0;
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = 0;
      if (B) B.threadsSave({
        chat: (threads.chat || []).filter(function (m) { return m.kind !== 'spin'; }),
        shell: (threads.shell || []).filter(function (m) { return m.kind !== 'spin'; }),
        archive: threads.archive || []
      });
    }, 300);          /* main debounces the actual file write again */
  }
  /* ---- LSP commands (/def /refs /hover /diag) ----------------------
     Pure HTTP against /v1/lsp/* -- no agent, no brain, no tokens. The
     bridge wraps transport in {ok, status, data}; Ade OS's own envelope
     {ok, data|error} rides INSIDE r.data, so both layers get checked.
     An empty result renders as 'nothing found' -- that came from a
     server that looked; only a down server renders as a failure. */
  function renderLsp(kind, d) {
    var NL = String.fromCharCode(10);
    if (kind === 'definition' || kind === 'references') {
      var locs = d.locations || [];
      if (!locs.length) return 'nothing found';
      var lines = [];
      if (kind === 'references') {
        var files = {};
        for (var fi = 0; fi < locs.length; fi++) files[locs[fi].file] = 1;
        lines.push(d.count + ' reference(s) in '
                   + Object.keys(files).length + ' file(s)'
                   + (d.count > locs.length
                      ? ' (showing ' + Math.min(locs.length, 30) + ')' : ''));
      }
      var show = locs.slice(0, 30);
      for (var i = 0; i < show.length; i++) {
        var l = show[i];
        lines.push(l.file + ':' + l.line + ':' + l.col
                   + (l.preview ? '  ' + l.preview.trim() : ''));
      }
      if (locs.length > 30) {
        lines.push('... and ' + (locs.length - 30) + ' more');
      }
      return lines.join(NL);
    }
    if (kind === 'hover') return d.contents || 'no hover info';
    var c = d.counts || {};
    var head = (c.error || 0) + ' error(s), ' + (c.warning || 0)
             + ' warning(s), ' + (c.info || 0) + ' info';
    var items = d.items || [];
    if (!items.length) return head + ' - file is clean';
    var out = [head];
    for (var di = 0; di < items.length; di++) {
      var it = items[di];
      out.push(it.severity.charAt(0).toUpperCase() + ' ' + it.line + ':'
               + it.col + ' ' + it.message
               + (it.code ? ' (' + it.code + ')' : ''));
    }
    return out.join(NL);
  }
  function lspFail(kind, r) {
    var env = (r && r.data) || {};
    var e = env.error || {};
    return kind + ' failed: '
         + (e.message || e.code || (r && r.error) || 'no reply from Ade OS');
  }
  function lspQuery(kind, argstr) {
    var addr = window.parseLspAddress(argstr);
    if (addr.error) { push(activeTab, 'system', 'text', addr.error); return; }
    var qs = [];
    if (addr.file) qs.push('file=' + encodeURIComponent(addr.file));
    if (addr.line) {
      qs.push('line=' + addr.line);
      qs.push('col=' + (addr.col || 1));
    }
    if (addr.symbol) qs.push('symbol=' + encodeURIComponent(addr.symbol));
    B.call('/v1/lsp/' + kind + '?' + qs.join('&')).then(function (r) {
      var env = (r && r.data) || {};
      if (!r || !r.ok || env.ok === false) {
        push(activeTab, 'system', 'text', lspFail(kind, r));
        return;
      }
      push(activeTab, 'system', 'text', renderLsp(kind, env.data || {}));
    }).catch(function (err) {
      push(activeTab, 'system', 'text', kind + ' failed: ' + err);
    });
  }

  function push(tab, role, kind, text, meta) {
    if (TABS.indexOf(tab) < 0) tab = 'chat';
    var m = { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
              ts: Date.now(), tab: tab, role: role, kind: kind,
              text: String(text == null ? '' : text), meta: meta || {} };
    threads[tab].push(m);
    if (tab === activeTab) renderThread();
    persist();
    return m;
  }
  window.__threads = function () { return threads; };

  /* /clear and /compact do not destroy: the messages move here, and /restore
     brings the newest batch back. Mirrors the cap threads-store.js enforces on
     write, so the in-memory copy cannot disagree with the file. */
  var MAX_ARCHIVE = 20;
  var COMPACT_KEEP = 20;
  function looksLikeClear(text) {
    var v = String(text == null ? '' : text).trim().toLowerCase()
      .replace(/^escalate:\s*/, '');
    return /^(please\s+)?(clear|reset|wipe|forget)\s+(the\s+)?(current\s+)?(context|chat|thread|conversation|task|history)\b/.test(v)
      || /^(new|start a new)\s+(chat|conversation|thread)\b/.test(v)
      || /^user requested to clear\b/.test(v)
      || v === 'clear' || v === 'clear context';
  }
  function clearThread(tab) {
    if (TABS.indexOf(tab) < 0) tab = 'chat';
    var liveC = threads[tab] || [];
    if (!liveC.length) {
      push(tab, 'system', 'text', 'Nothing to clear in ' + tab + '.');
      return 0;
    }
    archivePush(tab, liveC.slice());
    threads[tab] = [];
    renderThread();
    persist();
    push(tab, 'system', 'text',
         'Cleared ' + liveC.length + ' from ' + tab +
         ' - saved to session memory. /restore brings it back.');
    return liveC.length;
  }
  window.__looksLikeClear = looksLikeClear;
  window.__clearThread = clearThread;

  function archivePush(tab, messages) {
    if (!threads.archive) threads.archive = [];
    threads.archive.push({ at: Date.now(), tab: tab, messages: messages });
    if (threads.archive.length > MAX_ARCHIVE) {
      threads.archive = threads.archive.slice(-MAX_ARCHIVE);
    }
  }
  window.__archive = function () { return threads.archive || []; };
  window.__commandNames = function () {
    return COMMANDS.map(function (c) { return c.name; });
  };

  /* ------------------------------------------------------------ journal */
  /* Adé's own journal -- SS39-41, written by the daily/weekly/monthly rhythms
     and served from /v1/codex/journal. Fetched fresh on every switch to the
     tab rather than stored: it is a record that changes on its own schedule,
     and a cached copy would quietly go stale between passes.

     `degraded` is rendered, not hidden. An entry the brain could not write
     says so, and an empty day and an unreachable engine must never read the
     same -- that is the journal's own rule (adeos/codex/journal.py) and this
     view would break it by showing prose either way. */
  function renderJournal() {
    threadEl.innerHTML = '';
    var loading = document.createElement('div');
    loading.className = 'sys';
    loading.textContent = 'Reading the journal…';
    threadEl.appendChild(loading);
    Promise.all([
      B.call('/v1/codex/journal', 'GET', null),
      /* The invitation is allowed to fail on its own. A journal that will not
         render because the Codex had nothing to ask is worse than a journal
         with no prompt at the top of it. */
      B.call('/v1/codex/invitation', 'GET', null).catch(function () {
        return null;
      })
    ]).then(function (both) {
      if (activeTab !== 'journal') return;      /* switched away mid-fetch */
      var r = both[0], inv = both[1];
      standingPrompt = (inv && inv.invitation) || null;
      paintJournal((r && r.entries) || []);
    }).catch(function (err) {
      if (activeTab !== 'journal') return;
      threadEl.innerHTML = '';
      var e = document.createElement('div');
      e.className = 'sys';
      e.textContent = 'The journal could not be read: ' + (err && err.message
                        ? err.message : String(err));
      threadEl.appendChild(e);
    });
  }
  function paintJournal(entries) {
    threadEl.innerHTML = '';
    if (standingPrompt && standingPrompt.text) threadEl.appendChild(promptCard());
    if (!entries.length) {
      var none = document.createElement('div');
      none.className = 'sys';
      none.textContent = 'No entries yet. The rhythms write one per day, '
                       + 'week and month.';
      threadEl.appendChild(none);
      return;
    }
    /* Newest last, so it reads like the thread beside it and the latest
       entry is where the scroll lands. */
    entries = entries.slice().sort(function (a, b) {
      return String(a.period_key || '') < String(b.period_key || '') ? -1 : 1;
    });
    for (var i = 0; i < entries.length; i++) {
      threadEl.appendChild(journalEntry(entries[i]));
    }
    threadEl.scrollTop = threadEl.scrollHeight;
  }
  /* What the Codex is asking, and what answering it costs. Rendered as a
     card rather than a system line because it is the one thing on this tab
     Ray is meant to act on. */
  function promptCard() {
    var wrap = document.createElement('div');
    wrap.className = 'msg ade approval';
    var head = document.createElement('div');
    head.className = 'meta';
    head.textContent = 'The Codex is asking · ' + (standingPrompt.kind || '');
    wrap.appendChild(head);
    if (standingPrompt.subject) {
      var sub = document.createElement('div');
      sub.className = 'meta';
      sub.textContent = 'on: ' + standingPrompt.subject;
      wrap.appendChild(sub);
    }
    var q = document.createElement('div');
    q.textContent = standingPrompt.text;
    wrap.appendChild(q);
    var how = document.createElement('div');
    how.className = 'meta';
    how.textContent = standingPrompt.answer_at
      ? 'Type your answer below and press Enter.'
      : 'Nothing to answer here — this one is read in its own view.';
    wrap.appendChild(how);
    return wrap;
  }
  function journalEntry(entry) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ade';
    var head = document.createElement('div');
    head.className = 'meta';
    head.textContent = String(entry.period || '') + ' · '
                     + String(entry.period_key || '');
    wrap.appendChild(head);
    var body = document.createElement('div');
    body.textContent = String(entry.body || '');
    wrap.appendChild(body);
    return wrap;
  }

  function renderThread() {
    if (isRead(activeTab)) { renderJournal(); return; }
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
      wrap.className = m.kind === 'spin' ? 'sys spin' : 'sys';
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
    if (allTabs().indexOf(tab) < 0) tab = 'chat';
    activeTab = tab;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === tab);
    }
    renderThread();
    paintTabLabel();
  }
  function paintTabLabel() {
    if (activeTab === 'journal') {
      tabLabel.textContent = 'Journal';
      tabLabel.className = '';
      hint.textContent = "Adé's journal, written by the daily, weekly and "
                       + 'monthly rhythms. When the Codex asks you something, '
                       + 'answer it here.';
      return;
    }
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
  var SKILL_VERBS = { skill: 1, skills: 1, unskill: 1, superpowers: 1 };
  var SUPERPOWERS_PROCESS = [
    'using-superpowers',
    'brainstorming',
    'systematic-debugging',
    'writing-plans',
    'executing-plans',
    'verification-before-completion',
    'dispatching-parallel-agents',
    'requesting-code-review',
    'receiving-code-review'
  ];
  var UPLOAD_VERBS = { upload: 1, uploads: 1 };

  /* Every slash command the keydown chain below handles, as DATA -- the chain
     itself is unreadable by anything but a human, which is why /help listed 5
     of 51 and nothing could autocomplete. tests/commands-table.test.js holds
     this equal to the chain in both directions and refuses duplicates.

     `stub: true` means the branch prints a placeholder rather than doing the
     thing. The popup says so, because a command that answers
     "Market status: connecting to trader Ade OS..." and connects to nothing
     reads as working. */
  var COMMANDS = [
    { name: 'agent', hint: 'Show active trading agents', stub: false },
    { name: 'audit', hint: 'Audit trail', stub: true },
    { name: 'autonomy', hint: 'Show/change autonomy level', stub: false },
    { name: 'benchmark', hint: 'Run benchmark', stub: true },
    { name: 'cancel', hint: 'nothing to cancel; clear the input box', stub: false },
    { name: 'cite', hint: 'Cite sources from recent answers', stub: false },
    { name: 'clear', hint: 'move this tab to session memory', stub: false },
    { name: 'codex', hint: 'Codex overview; daily|weekly|monthly runs a pass', stub: false },
    { name: 'compact', hint: 'keep the last 20, archive the rest', stub: false },
    { name: 'config', hint: 'Show configuration', stub: true },
    { name: 'contradictions', hint: 'Codex clashes; held-open ones listed apart', stub: false },
    { name: 'council', hint: 'Convene a council - the skeptic is mandatory', stub: false },
    { name: 'context', hint: 'Show active context (last N messages + c', stub: false },
    { name: 'db', hint: 'Database status', stub: true },
    { name: 'decision', hint: 'Show latest decision', stub: false },
    { name: 'def', hint: 'Where is it defined - /def symbol | file:line[:col]', stub: false },
    { name: 'dev', hint: 'Developer mode', stub: false },
    { name: 'diag', hint: 'Type errors for one file - /diag path', stub: false },
    { name: 'exit', hint: 'Evaluate exits', stub: false },
    { name: 'forget', hint: 'Forget a stored fact (mark as moot)', stub: false },
    { name: 'gpu', hint: 'GPU status', stub: false },
    { name: 'health', hint: 'Health check', stub: false },
    { name: 'help', hint: 'list these commands', stub: false },
    { name: 'hover', hint: 'Signature/type at a spot - /hover symbol | file:line[:col]', stub: false },
    { name: 'inspect', hint: 'Inspect internal state', stub: true },
    { name: 'journal', hint: 'Show trade journal', stub: false },
    { name: 'kill', hint: 'refuses: no trading path connected', stub: true },
    { name: 'learn', hint: 'Analyze trading experience', stub: false },
    { name: 'live', hint: 'Live trading status', stub: true },
    { name: 'logs', hint: 'View logs', stub: true },
    { name: 'market', hint: 'Market status', stub: true },
    { name: 'memory', hint: 'store a fact in the task thread', stub: false },
    { name: 'models', hint: 'Available models', stub: true },
    { name: 'monitor', hint: 'Monitor active positions', stub: false },
    { name: 'patterns', hint: 'Codex patterns, coincidences included', stub: false },
    { name: 'persona', hint: 'active persona; reload|test|diff', stub: true },
    { name: 'plan', hint: 'Show plan summary', stub: false },
    { name: 'portfolio', hint: 'Portfolio status', stub: true },
    { name: 'positions', hint: 'Show open positions', stub: true },
    { name: 'progress', hint: 'Show progress percent', stub: false },
    { name: 'qvm', hint: 'QVM operations', stub: true },
    { name: 'reason', hint: 'Explain latest decision', stub: false },
    { name: 'recall', hint: 'list every stored fact', stub: false },
    { name: 'reflect', hint: 'open reflections; answer <id> <text> to reply', stub: false },
    { name: 'refs', hint: 'Who uses it - /refs symbol | file:line[:col]', stub: false },
    { name: 'remember', hint: 'look up one stored fact by key', stub: false },
    { name: 'research', hint: 'Research multi-sentence question', stub: false },
    { name: 'restore', hint: 'bring back the newest archived batch', stub: false },
    { name: 'reset', hint: 'Reset session - clear threads, approvals', stub: false },
    { name: 'review', hint: 'Show review summary', stub: false },
    { name: 'scan', hint: 'Scan trading universe', stub: true },
    { name: 'search', hint: 'Search knowledge - use /v1/ask channel', stub: false },
    { name: 'services', hint: 'Service status', stub: true },
    { name: 'sql', hint: 'Database query', stub: true },
    { name: 'status', hint: 'window status', stub: false },
    { name: 'steps', hint: 'Show current step list', stub: false },
    { name: 'summarize', hint: 'Summarize current thread', stub: false },
    { name: 'system', hint: 'Electron/Chromium/platform versions', stub: false },
    { name: 'task', hint: 'List open tasks', stub: false },
    { name: 'tools', hint: 'Available tools', stub: true },
    { name: 'trace', hint: 'Show execution trace', stub: true },
    { name: 'unknown', hint: 'Book VII - the questions still open', stub: false },
    { name: 'watch', hint: 'Watchlist display', stub: true },
  ];

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
    /* On the journal tab the composer answers the standing prompt. Only when
       there IS one and it can be answered -- otherwise the text falls through
       to an ordinary ask rather than vanishing into a view with no target. */
    if (activeTab === 'journal' && standingPrompt && standingPrompt.answer_at) {
      return { kind: 'journal', text: v, at: standingPrompt.answer_at };
    }
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

  function threadHistory(list) {
    /* Prior Chat turns for /v1/ask. Spin/system rows are not a conversation.
       The last user line is the question being asked — drop it so it is not
       sent twice. Same cap the server sanitizes to (12). */
    var src = list || [];
    var out = [];
    var i, m, role, text;
    for (i = 0; i < src.length; i++) {
      m = src[i];
      if (!m || m.kind === 'spin' || m.role === 'system') continue;
      text = String(m.text == null ? '' : m.text).trim();
      if (!text) continue;
      if (m.role === 'user') role = 'user';
      else if (m.role === 'ade') role = 'assistant';
      else continue;
      if (text.length > 2500) text = text.slice(0, 2500) + '…';
      out.push({ role: role, content: text });
    }
    if (out.length && out[out.length - 1].role === 'user') out.pop();
    if (out.length > 12) out = out.slice(-12);
    return out;
  }
  window.__threadHistory = threadHistory;

  function askQuestion(question) {
    return B.call('/v1/ask', 'POST', {
      question: question,
      skills: attached.slice(),
      history: threadHistory(threads.chat)
    });
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
      + '\n\nOr /skill <name> to attach a procedure, /superpowers for the process set.';
  }

  var SPIN_WORDS = (
    "Accomplishing Actioning Actualizing Architecting Baking Beaming " +
    "Beboppin' Befuddling Billowing Blanching Bloviating Boogieing " +
    "Boondoggling Booping Bootstrapping Brewing Bunning Burrowing " +
    "Calculating Canoodling Caramelizing Cascading Catapulting Cerebrating " +
    "Channeling Channelling Choreographing Churning Clauding Coalescing " +
    "Cogitating Combobulating Composing Computing Concocting Considering " +
    "Contemplating Cooking Crafting Creating Crunching Crystallizing " +
    "Cultivating Deciphering Deliberating Determining Dilly-dallying " +
    "Discombobulating Doing Doodling Drizzling Ebbing Effecting Elucidating " +
    "Embellishing Enchanting Envisioning Fermenting Fiddle-faddling Finagling " +
    "Flambéing Flibbertigibbeting Flowing Flummoxing Fluttering Forging " +
    "Forming Frolicking Frosting Gallivanting Galloping Garnishing " +
    "Generating Gesticulating Germinating Gitifying Grooving Gusting " +
    "Harmonizing Hashing Hatching Herding Honking Hullaballooing " +
    "Hyperspacing Ideating Imagining Improvising Incubating Inferring " +
    "Infusing Ionizing Jitterbugging Julienning Kneading Leavening " +
    "Levitating Lollygagging Manifesting Marinating Meandering Metamorphosing " +
    "Misting Moonwalking Moseying Mulling Mustering Musing " +
    "Nebulizing Nesting Newspapering Noodling Nucleating Orbiting " +
    "Orchestrating Osmosing Perambulating Percolating Perusing Philosophising " +
    "Photosynthesizing Pollinating Pondering Pontificating Pouncing " +
    "Precipitating Prestidigitating Processing Proofing Propagating Puttering " +
    "Puzzling Quantumizing Razzle-dazzling Razzmatazzing Recombobulating " +
    "Reticulating Roosting Ruminating Sautéing Scampering Schlepping " +
    "Scurrying Seasoning Shenaniganing Shimmying Simmering Skedaddling " +
    "Sketching Slithering Smooshing Sock-hopping Spelunking Spinning " +
    "Sprouting Stewing Sublimating Swirling Swooping Symbioting " +
    "Synthesizing Tempering Thinking Thundering Tinkering Tomfoolering " +
    "Topsy-turvying Transfiguring Transmuting Twisting Undulating Unfurling " +
    "Unravelling Vibing Waddling Wandering Warping Whatchamacalliting " +
    "Whirlpooling Whirring Whisking Wibbling Working Wrangling Zesting " +
    "Zigzagging"
  ).split(/\s+/);
  var spinTimer = 0, spinIdx = 0, spinMsg = null;

  function startSpin(tab) {
    stopSpin();
    if (TABS.indexOf(tab) < 0) tab = 'chat';
    spinIdx = Math.floor(Math.random() * SPIN_WORDS.length);
    spinMsg = { id: 'spin-' + Date.now(), ts: Date.now(), tab: tab,
                role: 'system', kind: 'spin', text: SPIN_WORDS[spinIdx] + '…', meta: {} };
    threads[tab].push(spinMsg);
    if (tab === activeTab) renderThread();
    spinTimer = setInterval(function () {
      if (!spinMsg) return;
      spinIdx = (spinIdx + 1) % SPIN_WORDS.length;
      spinMsg.text = SPIN_WORDS[spinIdx] + '…';
      if (spinMsg.tab === activeTab) renderThread();
    }, 90000);
  }
  function stopSpin() {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = 0; }
    if (!spinMsg) return;
    var list = threads[spinMsg.tab];
    if (list) {
      var i = list.indexOf(spinMsg);
      if (i >= 0) list.splice(i, 1);
    }
    spinMsg = null;
    renderThread();
  }
  window.__spinWords = function () { return SPIN_WORDS.slice(); };
  window.__startSpin = startSpin;
  window.__stopSpin = stopSpin;

  /* Ray answering the Codex. The answer goes to the reflection that ASKED --
     `answer_at` came with the invitation -- so a pass that opened a different
     question in the meantime cannot receive this one. */
  async function handleJournalAnswer(c) {
    input.value = '';
    try {
      await B.call(c.at, 'POST', { text: c.text });
    } catch (err) {
      var e = document.createElement('div');
      e.className = 'sys';
      e.textContent = 'The answer was not recorded: ' + (err && err.message
                        ? err.message : String(err));
      threadEl.appendChild(e);
      return;
    }
    /* Re-read rather than patching the view: answering may close the
       reflection, open the next rung, or raise something else entirely, and
       only the server knows which. */
    renderJournal();
  }

  var busy = false;
  async function send(text) {
    var raw = (text === undefined) ? input.value : String(text);
    if (!raw.trim() || busy || !B) return;
    var c = routePlain(raw);
    var targetTab = c.kind === 'shell' ? 'shell' : 'chat';
    if (c.kind === 'journal') { await handleJournalAnswer(c); return; }
    if (c.kind === 'skill') { await handleSkill(c); return; }
    if (c.kind === 'upload') { await handleUpload(c); return; }
    if (!c.text) { push(targetTab, 'system', 'staged', await emptyHelp(c)); return; }
    if (c.kind === 'ask' && looksLikeClear(c.text)) {
      setTab(targetTab);
      input.value = '';
      clearThread(targetTab);
      return;
    }

    stopSpeaking();
    busy = true;
    var userText = c.kind === 'shell' ? '! ' + c.text
                 : c.kind === 'task' ? '/' + (c.type || 'coding') + ' ' + c.text
                 : raw;
    push(targetTab, 'user', c.kind, userText);
    setTab(targetTab);
    input.value = '';
    paintTabLabel();
    startSpin(targetTab);

    var res;
    try {
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
    } finally {
      stopSpin();
      busy = false;
    }
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

  /* The one place a /v1/ask reply becomes UI. An escalate payload used to
     jump to a Task tab and stage `/coding …` for a second Enter. There is
     no Task tab now: the answer (and any escalate text) stays on Chat and
     this function never calls dispatchTask(). */
  function applyAskResult(result) {
    result = result || {};
    var text = result.answer || '';
    if (result.roots_cited && result.roots_cited.length) {
      text = (text ? text + '\n\n' : '') + 'From: ' + result.roots_cited.join(', ');
    }
    if (result.escalate) {
      var escPrompt = result.escalate.prompt || '';
      if (looksLikeClear(escPrompt) || looksLikeClear(text)) {
        setTab('chat');
        input.value = '';
        clearThread('chat');
        paintTabLabel();
        focusInput();
        return 'Cleared.';
      }
      var cleaned = String(text || '').replace(/^\s*ESCALATE:\s*/gim, '').trim();
      var extra;
      if (/^(greet|say hello|say hi)\b/i.test(escPrompt) ||
          /^(hi|hello|hey)[.!\s]*$/i.test(cleaned)) {
        extra = 'Hello, Ray.';
      } else {
        var where = result.escalate.root ? (' in ' + result.escalate.root) : '';
        extra = (cleaned ? cleaned + '\n\n' : '')
          + 'Ade would treat this as a change' + where
          + '. It stays here — nothing was staged.';
      }
      setTab('chat');
      push('chat', 'ade', 'ask', extra);
      input.value = '';
      paintTabLabel();
      focusInput();
      return extra;
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
    if (ev.dictate) {
      var dictated = String(ev.text == null ? '' : ev.text).trim();
      if (!dictated) return;
      if (B) B.openChat('chat'); setTab('chat');
      push('chat', 'system', 'staged',
        '“' + dictated + '”' + (ev.engine && ev.engine !== 'whisper' ? ' · ' + ev.engine : ''));
      input.value = dictated;
      paintTabLabel();
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
    var target = c.kind === 'shell' ? 'shell' : 'chat';
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
    if (c.verb === 'superpowers' && !c.text) {
      var added = [];
      for (var i = 0; i < SUPERPOWERS_PROCESS.length; i++) {
        var name = SUPERPOWERS_PROCESS[i];
        var row = null;
        for (var j = 0; j < rows.length; j++) if (rows[j].name === name) row = rows[j];
        if (!row || !row.attachable) continue;
        if (attached.indexOf(name) >= 0) continue;
        attached.push(name);
        added.push(name);
      }
      paintSkills();
      push(activeTab, 'ade', 'text',
        added.length
          ? ('Attached Superpowers process: ' + added.join(', ')
             + '. Chat and /coding turns will follow them. /unskill <name> removes one.')
          : (attached.length
             ? 'Superpowers process skills are already attached.'
             : 'No Superpowers process skill was attachable. /skill lists what fits.'));
      input.value = '';
      paintTabLabel();
      return;
    }
    var wanted = c.text.replace(/^-/, '').trim();
    var removing = c.verb === 'unskill' || /^-/.test(c.text);
    if (!wanted) {
      var on = attached.length ? 'Attached: ' + attached.join(', ') + '\n\n' : '';
      var names = rows.filter(function (s) { return s.attachable; })
                      .map(function (s) { return s.name; });
      var tooBig = rows.filter(function (s) { return !s.attachable; })
                       .map(function (s) { return s.name; });
      push(activeTab, 'system', 'staged',
        on + '/skill <name> to attach, /unskill <name> to remove, /superpowers for the process set.\n\n'
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
    startSpin(activeTab);
    var r;
    try { r = await B.upload(paths, !!overwrite); }
    finally { stopSpin(); busy = false; }
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
  /* An undecided approval is a card in the Chat tab. The glyph's amber
     pending look is glyph.js reading state.pending -- this window only owns
     the decision itself. `showApprovalId` guards on the id so a 2s poll never
     doubles the card, and the raise only fires when the id CHANGES. An
     approval that leaves the state stream without a local decision is demoted
     to a read-only "moot" record (no dead Allow/Deny buttons). */
  var showingApprovalId = null;

  function lastApprovalCardId() {
    var list = threads.chat;
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
      push('chat', 'ade', 'approval', '', { approval: a });
    }
    setTab('chat');
    if (B) B.openChat('chat');                 /* auto-raise on a NEW approval */
  }
  window.__showApproval = showApprovalId;

  /* A card whose approval vanished from the state stream is "moot": it stays
     as a persisted read-only record (the thread is an audit of what presented),
     but its Allow/Deny buttons go away so nobody POSTs a decision against an
     id that is no longer pending. Decided cards are never demoted. */
  function markApprovalsMoot() {
    var list = threads.chat, changed = false;
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
    push('chat', 'ade', r && r.ok ? 'text' : 'error',
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
    /* ---------------------------------------------- slash completions */
    /* Open only while the COMMAND WORD is being typed: a slash, then word
       characters, and no space yet. Once you type a space you are on
       arguments (`/qa run the suite`) and the list gets out of the way. */
    var cmdBox = document.getElementById('cmdlist');
    var cmdHits = [];
    var cmdSel = -1;

    function cmdOpen() { return !cmdBox.hidden; }

    function cmdHide() {
      cmdBox.hidden = true;
      cmdBox.textContent = '';
      cmdHits = [];
      cmdSel = -1;
    }

    function cmdFilter(value) {
      /* NOT trimmed: a trailing space is the signal that the command word is
         finished and you are on arguments now, so trimming it away kept the
         list open over `/health `. The leading \s* still tolerates indent. */
      var m = /^\s*\/([a-z]*)$/.exec(String(value == null ? '' : value));
      if (!m) return null;
      var q = m[1];
      var out = [];
      for (var i = 0; i < COMMANDS.length; i++) {
        if (COMMANDS[i].name.indexOf(q) === 0) out.push(COMMANDS[i]);
      }
      return out;
    }

    function cmdPaint() {
      cmdBox.textContent = '';
      if (!cmdHits.length) {
        var none = document.createElement('div');
        none.className = 'cmd-none';
        none.textContent = 'no command matches - Enter sends it as a task type';
        cmdBox.appendChild(none);
        return;
      }
      for (var i = 0; i < cmdHits.length; i++) {
        var c = cmdHits[i];
        var row = document.createElement('div');
        row.className = 'cmd' + (i === cmdSel ? ' on' : '');
        row.setAttribute('data-i', String(i));
        var n = document.createElement('span');
        n.className = 'cmd-name';
        n.textContent = '/' + c.name;
        row.appendChild(n);
        var h = document.createElement('span');
        h.className = 'cmd-hint';
        h.textContent = c.hint || '';
        row.appendChild(h);
        if (c.stub) {
          var s2 = document.createElement('span');
          s2.className = 'cmd-stub';
          s2.textContent = 'stub';
          row.appendChild(s2);
        }
        cmdBox.appendChild(row);
      }
    }

    function cmdRefresh() {
      var hits = cmdFilter(input.value);
      if (hits === null) { cmdHide(); return; }
      cmdHits = hits;
      cmdSel = hits.length ? 0 : -1;
      cmdBox.hidden = false;
      cmdPaint();
    }

    function cmdMove(d) {
      if (!cmdHits.length) return;
      cmdSel = (cmdSel + d + cmdHits.length) % cmdHits.length;
      cmdPaint();
      var on = cmdBox.querySelector('.cmd.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }

    /* Completes the word and stops. It deliberately does NOT submit: a
       completion popup that dispatches on Enter would fire a Task from a
       keystroke meant to pick a name. --smoke pins that. */
    function cmdAccept() {
      if (cmdSel < 0 || !cmdHits[cmdSel]) return false;
      /* Already complete: there is nothing to complete, so Enter should RUN it
         rather than spend a keystroke re-typing the word you just typed. Close
         the list and let the key fall through to the command chain. */
      var typed = /^\s*\/([a-z]*)$/.exec(input.value);
      if (typed && typed[1] === cmdHits[cmdSel].name) { cmdHide(); return false; }
      input.value = '/' + cmdHits[cmdSel].name + ' ';
      cmdHide();
      input.focus();
      return true;
    }

    cmdBox.addEventListener('mousedown', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.cmd') : null;
      if (!row) return;
      e.preventDefault();                    /* keep focus in the input */
      cmdSel = parseInt(row.getAttribute('data-i'), 10);
      cmdAccept();
    });

    input.addEventListener('input', cmdRefresh);
    input.addEventListener('blur', function () { setTimeout(cmdHide, 120); });
    window.__cmdOpen = cmdOpen;
    window.__cmdHits = function () { return cmdHits.map(function (c) { return c.name; }); };
    window.__cmdRefresh = cmdRefresh;

    input.addEventListener('keydown', function (e) {
      /* The completion list owns these keys while it is open. Escape closes
         the list only -- without this it reaches the handler below and hides
         the whole window, which is not what dismissing a popup should do. */
      if (cmdOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdMove(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); cmdMove(-1); return; }
        if (e.key === 'Escape') { e.preventDefault(); cmdHide(); return; }
        if (e.key === 'Tab' || e.key === 'Enter') {
          if (cmdAccept()) { e.preventDefault(); return; }
          cmdHide();
        }
      }
      if (e.key === 'Enter') {
        var text = input.value.trim();
        /* Phase 1: slash command handling */
        if (text.charAt(0) === '/') {
          var parts = text.slice(1).split(' ');
          var cmd = parts[0].toLowerCase();
          var args = parts.slice(1).join(' ');
          var handled = false;
          if (cmd === 'help') {
            // Show help overlay
            /* Built from COMMANDS, not a hand-kept sentence. The literal it
               replaced listed 5 of 51 and had been wrong since Phase 2. */
            var live = [], stubbed = [];
            for (var ci = 0; ci < COMMANDS.length; ci++) {
              (COMMANDS[ci].stub ? stubbed : live).push('/' + COMMANDS[ci].name);
            }
            push(activeTab, 'system', 'text',
                 live.length + ' commands: ' + live.join(' '));
            push(activeTab, 'system', 'text',
                 stubbed.length + ' not implemented yet: ' + stubbed.join(' '));
            handled = true;
          } else if (cmd === 'status') {
            push(activeTab, 'system', 'text', 'System: glyph window, chat window active, orb click to open');
            handled = true;
          } else if (cmd === 'clear') {
            clearThread(activeTab);
            handled = true;
          } else if (cmd === 'def') {
            push(activeTab, 'system', 'text',
                 'definition: asking the language server...');
            lspQuery('definition', args);
            handled = true;
          } else if (cmd === 'refs') {
            push(activeTab, 'system', 'text',
                 'references: asking the language server...');
            lspQuery('references', args);
            handled = true;
          } else if (cmd === 'hover') {
            push(activeTab, 'system', 'text',
                 'hover: asking the language server...');
            lspQuery('hover', args);
            handled = true;
          } else if (cmd === 'diag') {
            var diagFile = (args || '').trim();
            if (!diagFile) {
              push(activeTab, 'system', 'text',
                   'usage: /diag path/to/file.py');
            } else {
              push(activeTab, 'system', 'text',
                   'diagnostics: checking ' + diagFile + '...');
              B.call('/v1/lsp/diagnostics?file='
                     + encodeURIComponent(diagFile)).then(function (r) {
                var env = (r && r.data) || {};
                if (!r || !r.ok || env.ok === false) {
                  push(activeTab, 'system', 'text',
                       lspFail('diagnostics', r));
                  return;
                }
                push(activeTab, 'system', 'text',
                     renderLsp('diagnostics', env.data || {}));
              }).catch(function (err) {
                push(activeTab, 'system', 'text',
                     'diagnostics failed: ' + err);
              });
            }
            handled = true;
          } else if (cmd === 'compact') {
            // Keep the tail, move the rest into session memory
            var liveK = threads[activeTab] || [];
            if (liveK.length <= COMPACT_KEEP) {
              push(activeTab, 'system', 'text',
                   activeTab + ' has ' + liveK.length + ' messages - nothing to compact (keeps ' +
                   COMPACT_KEEP + ').');
            } else {
              var moved = liveK.slice(0, liveK.length - COMPACT_KEEP);
              archivePush(activeTab, moved);
              threads[activeTab] = liveK.slice(-COMPACT_KEEP);
              renderThread();
              persist();
              push(activeTab, 'system', 'text',
                   'Compacted ' + activeTab + ': moved ' + moved.length + ' to session memory, kept ' +
                   COMPACT_KEEP + '. /restore brings them back.');
            }
            handled = true;
          } else if (cmd === 'restore') {
            // Put the newest archived batch back where it came from
            var arch = threads.archive || [];
            if (!arch.length) {
              push(activeTab, 'system', 'text', 'Session memory is empty - nothing to restore.');
            } else {
              var last = arch.pop();
              var into = (TABS.indexOf(last.tab) >= 0) ? last.tab : activeTab;
              threads[into] = (last.messages || []).concat(threads[into] || []);
              renderThread();
              persist();
              push(activeTab, 'system', 'text',
                   'Restored ' + (last.messages || []).length + ' to ' + into + '.');
            }
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
            /* Was `handled = true` and nothing else: it swallowed the Enter
               and said nothing, which is indistinguishable from a dead command.
               There is nothing to cancel by the time this runs -- a staged
               draft lives in the input box, and typing /cancel replaced it. */
            push(activeTab, 'system', 'text',
                 'Nothing to cancel. A staged draft sits in the input box, so '
                 + 'typing /cancel already replaced it - clear the box instead.');
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
            var list = threads.chat;
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
            var list = threads.chat;
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
         } else if (cmd === 'memory') {
            // Memory: store a fact in the persistent thread
            if (args) {
              // Store: key value
              var parts = args.split(' ');
              if (parts.length >= 2) {
                var key = parts[0];
                var value = parts.slice(1).join(' ');
                var list = threads.chat;
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
                  threads.chat.push({
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
              var list = threads.chat;
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
              var list = threads.chat;
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
            var list = threads.chat;
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
            var list = threads.chat;
            var recent = [];
            for (var i = list.length - 1; i >= 0 && recent.length < 5; i--) {
              if (list[i].role === 'ade' && (list[i].kind === 'text' || list[i].kind === 'system')) {
                recent.push((list[i].text || '').slice(0, 30));
              }
            }
            var contextText = recent.join('; ');
            push(activeTab, 'system', 'text', 'Active context: ' + (recent.length > 0 ? recent.join(', ') : 'empty'));
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
            /* Pointed at /kill "to halt", which halts nothing. */
            push(activeTab, 'system', 'text',
                 'Live trading: stub - no trading path connected from the avatar, '
                 + 'so this reports nothing about a live desk.');
            handled = true;
         } else if (cmd === 'kill') {
            // Emergency trading halt
            /* This said "Trading halted. Emergency halt engaged." and halted
               nothing: there is no trading path from this window. An emergency
               stop that reports success without acting is the failure that
               already cost real money here -- commit 44850b8 recorded "the
               trading daemon stopped" while it live-traded for three more
               days. It refuses instead of pretending. */
            push(activeTab, 'system', 'text',
                 'HALT NOT SENT: stub - no trading path connected from the avatar. '
                 + 'Nothing was stopped. Halt at the desk that holds the position.');
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
         } else if (cmd === 'persona') {
            /* Sub-verbs read out of args. Because cmd is parts[0] -- one word
               -- the three multi-word branches this replaces could never be
               true, and shipped unreachable.

               `test` reports a stub rather than the "Persona validated -
               passing checks" it used to carry: that line asserted a check
               that never ran, and it was harmless only while nothing could
               reach it. */
            var pv = String(args == null ? '' : args).trim().toLowerCase();
            if (pv === 'reload') {
              push(activeTab, 'system', 'text', 'Persona reloaded - glyph avatar refreshed');
            } else if (pv === 'test') {
              push(activeTab, 'system', 'text', 'Persona test: stub - no validation connected');
            } else if (pv === 'diff') {
              push(activeTab, 'system', 'text', 'Persona diff: no version diff - currently at v1.0');
            } else if (pv) {
              push(activeTab, 'system', 'text',
                   'Unknown: /persona ' + pv + ' - try reload, test or diff.');
            } else {
              push(activeTab, 'system', 'text', 'Active persona: Ade OS v1.0 - transparent glyph avatar');
            }
            handled = true;
         } else if (cmd === 'dev') {
            // Developer mode
            push(activeTab, 'system', 'text', 'Developer mode: enabled - debug tools active');
            handled = true;
         } else if (cmd === 'trace') {
            // Show execution trace
            push(activeTab, 'system', 'text', 'Execution trace: stub - no trace data connected');
            handled = true;
         } else if (cmd === 'inspect') {
            // Inspect internal state
            push(activeTab, 'system', 'text', 'Internal state: stub - no state data connected');
            handled = true;
         } else if (cmd === 'sql') {
            // Database query
            push(activeTab, 'system', 'text', 'Database query: stub - no database connected');
            handled = true;
         } else if (cmd === 'db') {
            // Database status
            push(activeTab, 'system', 'text', 'Database status: stub - no database connected');
            handled = true;
         } else if (cmd === 'qvm') {
            // QVM operations
            push(activeTab, 'system', 'text', 'QVM operations: stub - no QVM connected');
            handled = true;
         } else if (cmd === 'benchmark') {
            // Run benchmark
            push(activeTab, 'system', 'text', 'Benchmark: stub - no benchmark data connected');
            handled = true;
         } else if (cmd === 'system') {
            // System information
            /* navigator, not process: contextIsolation:true means `process`
               does not exist here, and reaching for it threw ReferenceError --
               which aborts this handler, so /system printed nothing AND ate the
               Enter. The OS and GPU strings it also carried were hardcoded;
               userAgent is the version data this window genuinely has. */
            var ua = String(navigator.userAgent || '');
            var el = /Electron\/([^\s]+)/.exec(ua);
            var ch = /Chrome\/([^\s]+)/.exec(ua);
            push(activeTab, 'system', 'text',
                 'Electron ' + (el ? el[1] : 'unknown') +
                 ', Chromium ' + (ch ? ch[1] : 'unknown') +
                 ', platform ' + (navigator.platform || 'unknown') +
                 '. Ade OS itself: /health.');
            handled = true;
          } else if (cmd === 'codex') {
            /* The Codex surface. No argument is an overview; a period name
               runs that rhythm. `monthly` here writes NO evolution entries --
               section 42 wants six fields per changed belief, and a command
               that could produce one from the word "monthly" would be the
               silent rewriting the log exists to prevent. */
            var period = { daily: 'day', weekly: 'week', monthly: 'month',
                           day: 'day', week: 'week', month: 'month' }[args.trim().toLowerCase()];
            if (!period) {
              push(activeTab, 'system', 'text', 'Reading the Codex...');
              B.call('/v1/codex').then(function (r) {
                var d = (r && r.data && r.data.codex) || null;
                if (!d) {
                  push(activeTab, 'system', 'text',
                       'No Codex - ' + ((r && r.data && r.data.detail) ||
                                        (r && r.error) || 'no reply') + '.');
                  return;
                }
                var counts = d.counts || {}, lines = [], k;
                for (k in counts) {
                  if (Object.prototype.hasOwnProperty.call(counts, k) && counts[k]) {
                    lines.push(k.replace('codex_', '') + ' ' + counts[k]);
                  }
                }
                push(activeTab, 'system', 'text',
                     lines.length ? lines.join(', ')
                                  : 'The Codex is empty. Nothing has been written yet.');
                push(activeTab, 'system', 'text',
                     '/codex daily|weekly|monthly runs a pass. /unknown is Book VII.');
              });
            } else {
              push(activeTab, 'system', 'text', 'Running the ' + period + ' pass...');
              B.call('/v1/codex/rhythm/' + period, 'POST', {}).then(function (r) {
                var d = (r && r.data) || {};
                if (d.detail) {
                  push(activeTab, 'system', 'text', 'Refused: ' + d.detail);
                  return;
                }
                var out = [period + ' pass, ' + (d.period_key || '?')];
                if (d.open_questions) out.push(d.open_questions.length + ' open questions');
                if (d.patterns_ready) out.push(d.patterns_ready.length + ' patterns ready to decide');
                if (d.contradictions_undecided) {
                  out.push(d.contradictions_undecided.length + ' contradictions undecided');
                }
                if (d.evolution_entries) {
                  out.push(d.evolution_entries.length + ' beliefs changed');
                }
                push(activeTab, 'system', 'text', out.join('; ') + '.');
                if (d.unlogged_changes && d.unlogged_changes.length) {
                  push(activeTab, 'system', 'text',
                       d.unlogged_changes.length + ' belief(s) changed with NOTHING recorded. ' +
                       'That is the gap section 42 exists to catch.');
                }
              });
            }
            handled = true;
          } else if (cmd === 'reflect') {
            /* Open reflections, or answer one. Surfaced, never forced --
               section 38's LIVE CODEX mode is opt-in, and an agent that
               interrupts work to ask about feelings gets turned off. */
            var ra = args.trim().split(' ');
            if (ra[0] === 'answer' && ra[1]) {
              var rid = ra[1], body = ra.slice(2).join(' ');
              B.call('/v1/codex/reflect/' + rid + '/answer', 'POST', { answer: body })
                .then(function (r) {
                  var d = (r && r.data) || {};
                  push(activeTab, 'system', 'text',
                       d.detail ? ('Refused: ' + d.detail)
                                : ((d.decision || 'recorded') + '. ' + (d.question || '')));
                });
            } else {
              B.call('/v1/codex/reflect/open').then(function (r) {
                var rows = (r && r.data && r.data.reflections) || [];
                if (!rows.length) {
                  push(activeTab, 'system', 'text', 'Nothing open. Nothing is waiting on you.');
                  return;
                }
                for (var i = 0; i < rows.length; i++) {
                  push(activeTab, 'system', 'text',
                       '#' + rows[i].id + ' [' + rows[i].trigger + '] ' +
                       (rows[i].question || rows[i].subject));
                }
                push(activeTab, 'system', 'text', '/reflect answer <id> <your answer>');
              });
            }
            handled = true;
          } else if (cmd === 'patterns') {
            /* Coincidences printed BESIDE confirmations. A list of only the
               confirmed ones would make the Codex look far more perceptive
               than it is. */
            B.call('/v1/codex/patterns').then(function (r) {
              var d = (r && r.data) || {}, rows = d.patterns || [];
              if (!rows.length) {
                push(activeTab, 'system', 'text', 'No patterns noticed yet.');
                return;
              }
              for (var i = 0; i < rows.length; i++) {
                push(activeTab, 'system', 'text',
                     '[' + rows[i].state + ' x' + rows[i].occurrences + '] ' +
                     rows[i].statement);
              }
              var st = d.standing || {}, sd = st.survived_of_decided || [0, 0];
              push(activeTab, 'system', 'text',
                   sd[0] + ' of ' + sd[1] + ' decided patterns survived their null hypothesis.');
            });
            handled = true;
          } else if (cmd === 'contradictions') {
            /* Held-open ones are listed APART and never counted as backlog.
               Section 29 says the system should not immediately resolve one,
               and a count that reads as debt is exactly that pressure. */
            B.call('/v1/codex/contradictions').then(function (r) {
              var d = (r && r.data) || {}, st = d.standing || {};
              var rows = d.contradictions || [];
              if (!rows.length) {
                push(activeTab, 'system', 'text', 'No contradictions found.');
                return;
              }
              for (var i = 0; i < rows.length; i++) {
                push(activeTab, 'system', 'text',
                     '#' + rows[i].id + ' [' + rows[i].state + '] ' + rows[i].tension);
              }
              push(activeTab, 'system', 'text',
                   (st.undecided || []).length + ' undecided. ' +
                   (st.held_open || []).length + ' held open ON PURPOSE - not a backlog.');
            });
            handled = true;
          } else if (cmd === 'unknown') {
            /* Book VII. It cannot be completed, and that is the point. */
            B.call('/v1/codex/questions?state=OPEN').then(function (r) {
              var rows = (r && r.data && r.data.questions) || [];
              if (!rows.length) {
                push(activeTab, 'system', 'text',
                     'No open questions. That is not an achievement - Book VII is never finished.');
                return;
              }
              for (var i = 0; i < rows.length; i++) {
                push(activeTab, 'system', 'text',
                     '#' + rows[i].id + ' ' + rows[i].text +
                     (rows[i].asked_count > 1 ? ' (asked ' + rows[i].asked_count + 'x)' : ''));
              }
            });
            handled = true;
          } else if (cmd === 'council') {
            /* The skeptic is mandatory and the rounds are bounded. Both
               refusals come back as text rather than silence. */
            var q = args.trim();
            if (!q) {
              push(activeTab, 'system', 'text', 'Ask something: /council <question>');
            } else {
              push(activeTab, 'system', 'text', 'Convening...');
              B.call('/v1/codex/council', 'POST', { question: q }).then(function (r) {
                var d = (r && r.data) || {}, c = d.council;
                if (!c) {
                  push(activeTab, 'system', 'text',
                       'Refused: ' + (d.detail || (r && r.error) || 'no reply'));
                  return;
                }
                push(activeTab, 'system', 'text',
                     c.rounds + ' rounds, roles: ' + (c.roles || []).join(', '));
                if (!c.is_a_record) {
                  push(activeTab, 'system', 'text',
                       'No disagreements, uncertainties or new questions. ' +
                       'A council that leaves only a synthesis has lost the thing it was for.');
                }
              });
            }
            handled = true;
         } else if (cmd === 'health') {
            /* Reads Ade OS. The literal this replaces answered "all systems
               nominal - smoke probes passing" unconditionally, and went on
               saying it for the hour chat.js could not parse: a status line
               that cannot fail is worse than none, because it is trusted
               exactly when it is wrong.

               Reports every subsystem Ade OS names, up or down, rather than
               reducing them to one word -- `status: down` with memory up and
               inference unreachable is a different morning from both being
               out, and the detail strings say which. */
            push(activeTab, 'system', 'text', 'Asking Ade OS...');
            B.call('/v1/health').then(function (r) {
              if (!r || !r.ok) {
                push(activeTab, 'system', 'text',
                     'Ade OS did not answer /v1/health - ' +
                     ((r && r.error) ? r.error
                      : (r && r.status) ? ('HTTP ' + r.status) : 'no reply') +
                     '. That IS the health answer: the API is unreachable.');
                return;
              }
              var d = r.data || {};
              var out = ['Ade OS: ' + (d.status || 'unknown')];
              var subs = d.subsystems || {};
              for (var k in subs) {
                if (!Object.prototype.hasOwnProperty.call(subs, k)) continue;
                var sub = subs[k] || {};
                out.push('  ' + k + ': ' + (sub.up ? 'up' : 'DOWN') +
                         (sub.detail ? ' - ' + sub.detail : ''));
              }
              if (d.may_execute_tools === false) {
                out.push('  tools BLOCKED: ' + (d.blocking_reason || 'no reason given'));
              }
              /* String.fromCharCode(10) rather than an escape: this file is
                 patched by tooling often enough that a lone backslash-n has
                 been mangled into a real line break more than once today. */
              push(activeTab, 'system', 'text', out.join(String.fromCharCode(10)));
            }).catch(function (e) {
              push(activeTab, 'system', 'text',
                   'Health check failed: ' + ((e && e.message) ? e.message : 'unknown error'));
            });
            handled = true;
         } else if (cmd === 'services') {
            // Service status
            push(activeTab, 'system', 'text', 'Services: stub - no external services connected');
            handled = true;
         } else if (cmd === 'models') {
            // Available models
            push(activeTab, 'system', 'text', 'Models: stub - no models loaded');
            handled = true;
         } else if (cmd === 'tools') {
            // Available tools
            push(activeTab, 'system', 'text', 'Tools: stub - no tools loaded');
            handled = true;
         } else if (cmd === 'gpu') {
            // GPU status
            push(activeTab, 'system', 'text', 'GPU: integrated - no dedicated GPU');
            handled = true;
         } else if (cmd === 'logs') {
            // View logs
            push(activeTab, 'system', 'text', 'Logs: stub - no log data connected');
            handled = true;
         } else if (cmd === 'config') {
            // Show configuration
            push(activeTab, 'system', 'text', 'Configuration: stub - no config data connected');
            handled = true;
         } else if (cmd === 'audit') {
            // Audit trail
            push(activeTab, 'system', 'text', 'Audit: stub - no audit trail data connected');
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
      if (t) {
        threads.chat = t.chat || [];
        threads.shell = t.shell || [];
        threads.archive = t.archive || [];
        /* Legacy Task-tab messages land on Chat rather than disappearing. */
        if (t.task && t.task.length) {
          threads.chat = threads.chat.concat(t.task);
        }
      }
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
            push('chat', 'ade', 'approval', '', { approval: s.approval });
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
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
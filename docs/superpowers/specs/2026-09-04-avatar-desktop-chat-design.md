# Desktop Chat Window for the Ade Avatar — Design

**Date:** 2026-09-04
**Status:** Approved in brainstorming (2026-09-04)
**Repo:** `C:\Users\ray_g\ade-ai\adeos\avatar` (branch `main`, remote `r-anthony-graves/ade-metatron-avatar`)

## Problem

The avatar's whole command surface is the compact bar mounted under the glyph.
It shows only the latest reply, has no history, is tiny, and lives glued to an
always-on-top ornament. Chat "in the bar" is cramped and ephemeral. The request:
**let the conversation open into a desktop window.**

## Decisions locked in brainstorming (via the visual companion)

1. **Layout A** — the under-glyph command bar is **removed**. The glyph stays
   as the always-on-top presence; clicking it (or a hotkey / tray item) opens a
   normal desktop window.
2. **Separate tabs** — the window has **Chat**, **Shell**, and **Task** tabs,
   each an independent thread with real scrollback.
3. Threads **persist across app restarts**.
4. **Voice auto-opens the window** — push-to-talk and the always-live mic drop
   their transcripts into the window; no voice-only entrance exists outside it.
5. **The orb stays as launcher** while the window is open — it remains
   always-on-top, shows state, and clicking it focuses the window instead of
   opening a second one.

## Architecture

Two windows in one Electron process (the tray keeps the app alive either way):

```
┌──────────────────────────────────────────────────────────────┐
│ main.js                                                      │
│  windows: win (glyph) + chatWin (desktop)                    │
│  tray · globalShortcut · pollAde() · upload walk · threads IO│
└──────────────┬───────────────────────────────┬──────────────┘
               │ BrowserWindow                 │ BrowserWindow
┌──────────────▼──────────────┐   ┌────────────▼──────────────────┐
│ glyph window (win)          │   │ chat window (chatWin)         │
│ transparent · frameless     │   │ framed · resizable · taskbar  │
│ always-on-top · click-through│   │ visible on demand             │
│ ┌─────────────────────────┐ │   │ ┌──────────────────────────┐   │
│ │ glyph.js (canvas)       │ │   │ │ chat.html / chat.js      │  │
│ │ ui.js (drag, click, hit,│ │   │ │  tabs Chat|Shell|Task    │   │
│ │  mic/PTT engine, wake)  │ │   │ │  threads · approvals ·   │   │
│ └─────────────────────────┘ │   │ │  skills · upload · mic    │  │
└─────────────────────────────┘   └────────────────────────────┘   │
```

### The glyph window (`win`, existing)

- Stays frameless, transparent, always-on-top, click-through except over
  painted pixels (`applyHit()`, `painted()` — unchanged).
- Becomes size `S x S` (the `BAR_H` suffix is gone): it is now only the orb.
- **Single click** on the orb opens/focuses `chatWin` (replaces `toggleBar`).
  Drag to move (unchanged), right-click / tray menu (unchanged).
- Keeps owning the **live microphone and push-to-talk** (`ptt.js`, `micOn()`,
  `onUtterance`, wake flare, `setHearing`/`setMic`/`setSpeaking`). The audio
  track, the recogniser path, and the wake-word gate all stay here because they
  already work and moving the media layer would be a big change for no benefit.
- `#bar`, `#in`, `#out`, `#mode`, `#approve`, `#skills`, `#hint`, `#mic` are
  **deleted from `avatar.html`** and their `ui.js` logic moves to the chat
  window. `ui.js` shrinks to: drag/click/hit, mic + wake + speak, and relaying
  recognised speech to the chat window through main.

### The chat window (`chatWin`, new)

- Normal BrowserWindow: `frame: true`, titled `Ade`, resizable, movable,
  appears in the taskbar and alt-tab, **not** always-on-top, created hidden at
  launch (`show: false`).
- Default ~900x620, position remembered (reuse `clampToScreen`); last bounds
  persist in `avatar-state.json`.
- Loads `chat.html` with the same CSP (`default-src 'none'`, script-src self),
  the same preload bridge, and a new `threads` IPC surface.
- Closing the window hides it — the app keeps running with the orb. Reopening
  restores the threads from disk. Quit stays in the tray.

## Chat window UI (chat.html / chat.js)

- **Tab strip:** `Chat | Shell | Task`. One active tab; each tab renders its own
  thread scrollback and its own input focus.
- **Messages** render as labelled bubbles (existing avatar palette; shell
  commands and results are dark monospace cards, user text on the right, Ade's
  reply cream on the left — the vocabulary of today's mockups).
- **Mode by tab, prefixes still authoritative.** The active tab decides how a
  plain line is routed, but `classify()` stays the single classifier and `!`,
  `?`, `/` always override:
  - Chat: bare text → `{kind:'ask', route:'ground'}`; `?…` → chat completions.
  - Shell: bare text → shell; the tab labels itself "ungated" persistently
    (the old Shell hint text becomes the tab's standing label).
  - Task: bare text → `{kind:'task', type:'coding'}`; `/<type> …` respects the
    type. `/skill`, `/unskill`, `/upload` verbs work from any tab.
  - `spokenToTyped()` unchanged — voice words rewrite into the same prefixes.
- **Input row** at the bottom: input + **Mic** toggle + a one-line hint that
  names shortcuts; Esc hides the window; Ctrl/Cmd+C on a selected message copies
  it (replaces the old *copy last reply* shortcut).
- **Shell bubble:** command + stdout/exit code, one card. **Task bubble:**
  acceptance reply (`task <id> accepted`) plus inline **Allow / Deny** approval
  cards as they arrive. **Ask bubble:** answer + `From: <roots>` footer.
- **Staged commands** (escalations, recognised voice shell/task): a system line
  *"Staged as a task in `<root>` — press Enter to run or edit first."* and the
  input is prefilled and focused, awaiting the human beat. This is the exact
  role of today's bar staging, relocated.
- **Skills:** the attached-procedures chip row shows in the Task tab (they
  govern tasks). `attached[]` stays a live, unpersisted list as today.
- **Upload:** `/upload`, `/upload folder`, and drag-and-drop work. Because the
  window is a normal rectangle (no click-through), drop works whenever the
  window is visible — no more "only while the bar is open" caveat. `handleUpload`
  reports are bubbles in the active tab.
- **Mic button:** shows the real track state (Mute/Unmute) and toggles it. The
  track itself lives in the glyph renderer; this button drives it via main
  (see IPC below). Mirror of the tray item.

## Threads and persistence

- Each tab's thread is an array of messages persisted to
  `userData/threads.json` (main owns the file IO — the renderer cannot touch
  the filesystem, and must not start to).
- Message record:
  `{ id, ts, tab: 'chat'|'shell'|'task', role: 'user'|'ade'|'system',
     kind: 'text'|'ask'|'shell'|'task'|'error'|'approval'|'staged',
     text, meta }`
  — `meta` carries extras (command string, exit code, roots cited, root named,
  approval id/tool/args, upload report, task_id).
- **Append-on-send, not append-on-reply:** the user bubble is written when the
  message goes out; the reply bubble when it returns. A message sent while the
  window is hidden is already part of the thread when the window next opens.
- The chat renderer sends `threads:save` after every mutation; **main debounces
  the file write** (~400 ms) and flushes on window hide and app quit — one
  writer, no concurrent file access.
- **Corrupt file at load:** start empty, rename the bad file to
  `threads.json.bak` (never overwrite or delete data silently).
- No message cap in normal use (decision: persist across restarts, uncapped).
  The store keeps one hard safety floor so a runaway renderer cannot balloon
  the file: `saveThreads` trims each tab to its most recent 4,000 messages
  (`MAX_MESSAGES = 4000`).

## Data flow — sending

```
Enter (active tab, or prefix override)
  → classify(raw)                        [unchanged function]
  → if /skill,/upload → verbs (report to active tab)
  → if !text → emptyHelp as error bubble
  → append user bubble to target tab
  → shell   : POST /v1/terminal      {cmd}
    ask-ground: POST /v1/ask        {question}
    ask-chat : POST /v1/chat/completions
    task     : POST /v1/tasks       {description, task_type, topic:'u/local/avatar', skills:attached}
  → append result/error bubble (readReply)
  → speak reply if cfg.speak enables
```

## Data flow — voice

- Utterance arrives at the glyph renderer's `onUtterance` (unchanged):
  `stripWake` gates (drop if not addressed) → wake flare → classify.
- **An addressed utterance that will produce UI auto-opens `chatWin`**
  (locked decision 4); the one exception is the voice action `stop`, which only
  cuts off speech and opens nothing:
  - ground ask → Chat tab: user bubble, `/v1/ask`, answer bubble, speak.
  - spoken `shell …` / explicit task type → open the right tab and **stage** in
    the input (never dispatch — same property `voice.shellNeedsConfirm` and
    `pttSmoke.noDispatch` guard today).
  - `VOICE_ACTIONS`: reads answer into the Chat tab; `open the command bar`
    becomes *open the command window*; `stop` stays `stopSpeaking()` only.
- PTT (`pttDown`/`pttUp`) likewise drives the chat window's transcript; the
  "…listening / …recognising" status renders in the window.

## Data flow — approvals

- `pollAde()` (unchanged) finds open approvals → if not already shown, main
  tells the chat window to **append an approval card to the Task tab and raise
  the window**; the orb's existing "decision waiting" amber/arcs look stays.
- Allow/Deny posts `/v1/approvals/<id>/decide` with
  `{allow, reason:'allowed/denied from the desktop avatar', decided_by:'human'}`
  → result bubble. **Nothing about this path changes except the surface it is
  drawn on.**

## IPC surface (preload.js additions, both windows)

Main → chat renderer:

- `chat:focus (tab)` — show, focus, switch tab.
- `chat:append (message)` — main-side appends (approval raised, mic state sync,
  voice transcript staged from the glyph renderer).
- `mic:state (live)` — broadcast to both windows so the tray, the glyph, and
  the chat window's Mic button agree.

Chat renderer → main:

- `threads:load` / `threads:save (payload)` — the persistence namespace.
- `win:openChat`, `win:closeChat` — open/focus and hide.

Main relay:

- `win:micToggle` (chat) → `ui:micToggle` (glyph renderer, same handler today).
- Any `ui:*` that the glyph renderer still owns (arm, backing, speak, hush)
  continues to be delivered to the glyph renderer only.

Mouse/keyboard routing: the glyph window is never focusable now (`app:quit`…
`applyHit()` always sets `setFocusable(false)`); all keyboard input belongs to
`chatWin`. `win:bar` IPC is deleted.

## Shortcuts and tray (deltas)

- Hotkey **`bar`** becomes **`open-chat`**: shows/focuses `chatWin` (toggles
  visibility if it already has focus). Same fallback list
  (`Ctrl+Alt+A → Ctrl+Shift+A → Ctrl+Alt+G`).
- Tray: first item renamed **"Chat window"**. Everything else unchanged:
  speak a command, mic toggle + label, Mic-drives-glyph, click-through, speak
  replies, backing glow, Size (glyph only), Opacity (glyph window only),
  Reset position, Open Ade API, Restart Ade OS, Quit.

## Error handling

- **Ade OS offline / call failure:** error bubble in the active tab; a retry
  action re-sends the last user message. The orb's existing offline look is
  unchanged.
- **Corrupt threads file:** start empty + `.bak` the file (above).
- **Mic unavailable:** error bubble in the Chat tab instead of the old bar
  `say()` line.
- **Recogniser fallback (`engine !== 'whisper'`):** the transcript bubble notes
  ` · windows` exactly as today's bar reply does.
- **Approval timeout:** unchanged (`WaitingApprover` denies on timeout); the
  card shows the decision as it re-polls.

## Testing

- **`--smoke` is reworked, not trimmed.** The self-test's properties are the
  point of this codebase; every claim below survives or is rewritten to the new
  surface:
  - Glyph window probes unchanged: `probe`, `hit` (click-through corners vs
    glyph), `visible`, `tray`, frameless/transparent/always-on-top, no bar DOM.
  - Chat window probes (new): `chatWin` exists and is **framed**, **resizable**,
    taskbar-visible, initially hidden; tab strip present; threads `load`/`save`
    round-trips through a temp file.
  - Classifier contract unchanged (`slash`, `ask.bareInputAsks`,
    `prefixStillDispatches`, `shellUnchanged`, `explicitAskUnchanged`).
  - **Safety invariants re-asserted on the new surface:**
    `escalationDoesNotDispatch`, `escalationStagesTask` (input now in the Task
    tab), `escalationNamesRoot`, `clearsInputOnAnswer`,
    `shellNeedsConfirm` (recognition stages, never dispatches), and the
    `pttSmoke` block driven through main IPC → real `pttUp()` against a stub
    recorder (`dispatched` must not touch `/v1/terminal`, `/v1/tasks`,
    `/v1/approvals/*`).
  - Voice propagation properties kept: `voice` rewrites, `mic` wake gating +
    mute-zeroes-tracks, `hearing` audio-driven cues and wake flash (they touch
    glyph renderer functions that remain), `keys.hintMatchesBinding` /
    `takesNoOsKey` (hint now in the window), `slash`, `upload` walker.
  - New: an addressed speech path test — stubbed recogniser returns a ground
    ask → asserts the chat window opened and a Chat-tab bubble was appended.
- Commands: `& .\node_modules\electron\dist\electron.exe . --smoke
  --smoke-wait=9000`; plus a live manual pass of clicking the orb, voice, and
  approve/deny.

## Out of scope (YAGNI)

- Multiple conversations per tab, model switching, streamed/typed replies,
  markdown rendering (messages render as today's plain text), message delete,
  search, a history cap, per-tab skills, or an approval history view. The
  threads store is plain JSON precisely so any of these can be bolted on later.

## Files

| File | Change |
|---|---|
| `main.js` | create `chatWin` + hide/show; threads IO namespace; approval-raise + voice-relay IPC; delete `win:bar`/`BAR_H`; hotkey/tray wording; rework `--smoke` |
| `chat.html` (new) | the tabbed window; same CSP + palette as the avatar |
| `chat.js` (new) | tabs, threads, classify/send, approvals UI, skills, upload, mic mirror |
| `avatar.html` | delete `#bar` block entirely; glyph window is now `S x S` |
| `ui.js` | shrink to drag/click/hit, mic+PTT+wake+speak, voice relay to main |
| `preload.js` | add `chat:*`, `threads:*`, `win:openChat/closeChat`, mic-state broadcast |
| `ptt.js` | unchanged (media layer stays with the glyph) |
| `glyph.js` | unchanged |
| `README.md` | rewrite the command-bar sections for the window |
| `run-avatar.ps1` | unchanged (Electron still loads `main.js`) |

## Preserved invariants (non-negotiable)

1. `/v1/terminal` is ungated → a shell command is **never** dispatched by
   recognition or by an escalation; it always waits on a human Enter in the
   Shell tab.
2. `/v1/ask` answers or stages; `dispatchTask()` remains the only way to reach
   `/v1/tasks`, and an escalation never calls it.
3. Voice cannot approve; Allow/Deny is a human click (Task tab).
4. The Electron process never spawns a shell; all execution stays on loopback
   HTTP through the one preload bridge that re-checks `/v1/*`.
5. Renderer CSP stays `default-src 'none'`; no new renderer network access;
   file IO (threads, upload paths) stays in main.
6. The glyph remains click-through anywhere it is not painted, and never takes
   the keyboard.
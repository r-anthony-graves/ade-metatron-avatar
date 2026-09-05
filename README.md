# Ade avatar

A transparent, always-on-top Metatron glyph that sits on the desktop. It is
Ade's face and Ade's keyboard: it shows what Ade OS is doing, and you can drive
Ade from it without opening anything else.

```powershell
cd C:\Users\ray_g\ade-ai\adeos\avatar
npm install          # once
.\run-avatar.ps1     # start (detached, survives the shell that launched it)
.\run-avatar.ps1 -Status
.\run-avatar.ps1 -Stop
```

The glyph runs whether or not Ade OS is up. It does not depend on the WebUI, a
browser, or a terminal staying open.

## Using it

| | |
|---|---|
| **Drag** the glyph | move it anywhere, on any monitor; position is remembered |
| **Click** the glyph, **Ctrl+Alt+A**, or the tray's *Chat window* | open the desktop conversation window |
| **Right-click** the glyph, or the tray icon | menu: chat window, size, opacity, click-through, backing glow, restart Ade, quit |
| **Esc** | hide the conversation window (the orb and the tray keep the app alive) |

Clicking the orb is now the launcher: a single click opens the window with the
input focused. The orb itself never steals the keyboard — every keypress
belongs to the conversation window or to whatever is underneath the transparent
bits.

If you cannot find it, the saved position may be stale from a different monitor
layout. It is now clamped on startup so at least a corner always stays on a
real display, and **Reset position** in the tray menu drops it back to the
bottom-right.

The window has three tabs, and the labelless input row inherits the active
tab's default. The prefixes still override at every turn:

| You type (or the tab you are in) | Where it goes |
|---|---|
| Chat tab: `what is in glyph.js` | `POST /v1/ask` — a grounded read against the three machine-access roots; the reply names which root it read |
| Chat tab: `fix the failing test in test_gate.py` | `POST /v1/ask` decides this is a change, does nothing, and stages `/coding fix the failing test in test_gate.py` in the **Task tab** — **nothing runs until you press Enter** |
| Task tab, or `/qa run the trust-level suite` | `POST /v1/tasks` — an agent does the work, with an explicit task type |
| Shell tab, or `!git status` | `POST /v1/terminal` — direct subprocess |
| `?what brain are you on` | `POST /v1/chat/completions` — plain chat, no roots read |

**Drop files or folders straight onto the window** in any tab — same walk, same report.

Bare text used to dispatch a coding Task the instant you pressed Enter. It asks
now: `/v1/ask` either answers directly or — for anything that looks like a
change — does nothing and hands back what it would run, which lands in the Task
tab as a staged `/<type> <prompt>` for you to read before it does anything.
Every thread persists across restarts (`userData/threads.json`).

## Voice

**Ade speaks.** Turn on *Speak Ade's replies* in the tray. Replies come back as
audio from `/v1/voice/speak`, decoded straight from base64 WAV into Web Audio —
no blob URL, so the page keeps its `default-src 'none'` policy. The playing
waveform drives the core, so the glyph is the mouth: fast attack so consonants
land, slower release so it does not strobe between syllables. Asking something
new barges in and cuts off the old answer.

**You speak, and it is already listening.** The microphone is open by default
(Ray, 2026-08-27). Say **"Ade"** and then the command — "Ade, run the tests".
Anything not addressed to Ade is recognised locally, discarded, and dispatches
nothing. "Hey Ade" and "Ada" work too: all three transcribe to the same token,
which was measured against the live recogniser rather than assumed. "Adelaide"
does not trigger it — the wake token needs a separator after it.

**Mute stops the track.** The **Mute** button in the chat window, the tray item, and the
talk hotkey all do the same thing: they stop the microphone track, so the
operating system's own mic indicator goes out. It is not a filter that keeps
capturing and throws the results away — a mute that leaves the mic open is a
lie told by a checkbox. `--smoke` asserts the track count actually reaches zero.

The old push-to-talk path still exists behind the tray's "Speak a command":
press to start listening, the same item to stop,
and it stops itself after 8 seconds so a forgotten hotkey cannot leave the
microphone open. `globalShortcut` has no key-up event, which is why this is
press/press rather than true hold-to-talk.

**Which hotkey depends on what is free.** `register()` returns false when another
application already owns a combination, and a silent failure there is
indistinguishable from a dead app — on this machine `Ctrl+Alt+Space` was already
taken and push-to-talk did nothing. Each hotkey walks a list of candidates and
the tray menu shows the one that actually bound, or says
`(no hotkey available)` if none did:

| | tried, in order |
|---|---|
| Chat window | `Ctrl+Alt+A` → `Ctrl+Shift+A` → `Ctrl+Alt+G` |
| Speak a command | `Ctrl+Alt+Space` → `Ctrl+Shift+Space` → `Ctrl+Alt+V` |

**No OS key is asked for.** `globalShortcut` is system-wide, so whatever the
avatar takes is taken from every other application. `Alt+Space` (Windows' own
window menu) and `Super+Space` (the input-language switcher) used to head the
first list and always won, which quietly removed both from everything else on
the desktop. An ornament does not get to hold an OS key, so neither is
requested any more and `--smoke` asserts `keys.takesNoOsKey`.

**The hint line names the key that actually bound**, read back from
`app:shortcuts` rather than written into the markup. It advertised
`Ctrl+Alt+Space` while `Ctrl+Shift+Space` was live — a documented key that does
nothing is exactly what a dead app looks like, which is the failure this whole
fallback list exists to prevent. `keys.hintMatchesBinding` checks it by
transforming the displayed text back the other way, so a bug in the
pretty-printer cannot pass by being mirrored in the check.

The tray menu item works regardless of hotkeys. Audio is captured as raw PCM, downsampled to
16 kHz mono 16-bit WAV, and posted to `/v1/voice/listen`. Nothing leaves the
machine and nothing is written to disk either way.

**Recognition is open vocabulary now.** A whisper.cpp sidecar on loopback
(`:1242`) answers first — say anything, not just a fixed phrase list. The
response's `engine` field says which recogniser actually answered
(`"whisper"` or `"windows"`); when it is not `"whisper"` the spoken
transcript in the window is suffixed ` · windows` so a stopped sidecar reads
as a fallback, never as a silently worse model.

**If the sidecar is down, the live microphone goes SILENT, not degraded.**
Measured 2026-08-28. The fallback claim above holds for the push-to-talk path
and not for the always-live one, and the difference is the wake word: the
Windows floor can only ever return one of nine fixed phrases, and **none of
them contains "Ade"**. So `stripWake()` returns `null` for 9 of 9, every
utterance is discarded before anything is dispatched, and the orb sits there
looking like it is ignoring you. Check this before debugging anything else:

```powershell
py -3.12 C:\Users\ray_g\own-stt\ownstt.py status   # pid, health, model
py -3.12 C:\Users\ray_g\own-stt\ownstt.py start    # if health is down
```

Nothing restarts it on boot today, so a reboot leaves the microphone inert
with no visible sign of why. The `engine` field is the tell: anything other
than `"whisper"` means open speech is not running.

Recognition cost, same day, through `/v1/voice/listen`: **~150 ms** on the
sidecar against a flat **~2,230 ms** on the Windows floor -- and the floor's
cost is fixed per call, not proportional to what you said (0.74 s and 3.75 s
of audio both cost ~2.2 s).

Windows' own constrained-grammar recogniser is the **floor**: it only
answers when the sidecar is down, and only the phrases below still resolve
to a direct action. `GET /v1/voice/phrases` returns the current list. Say
one of these and it fires straight away, on either engine:

| Say | What happens |
|---|---|
| check the health / what are you doing / what is pending | reads Ade's state back |
| list the agents / show the backlog | reads and speaks the answer |
| run the tests | dispatches a task |
| read the file | opens the chat window primed for you to finish typing |
| open the command window | opens the chat window; **stop** cuts off speech and opens nothing |

Anything else is open speech: it is rewritten through the same leading-word
prefixes the chat window understands when typed (`shell …` → `!`, `ask …` →
`?`, `task <type> …` → `/<type>`). A recognised `shell`/`ask`/`task` keyword,
or an explicit task type, opens the matching tab and stages it in the window's
input for you to review and press Enter — it is never dispatched on
recognition alone.

Bare open speech — no leading keyword — is different: it is answered
straight away, spoken back, over `POST /v1/ask`. That is safe on recognition
alone because asking changes nothing: `/v1/ask` either answers a question or,
for anything that looks like a change, does nothing and hands back what it
would run, which stages in the Task tab as a `/<type> <prompt>` for
your own Enter. Speech never reaches `POST /v1/tasks` by itself.

### Voice cannot approve anything

Ade OS decided this before the avatar existed and `VoiceInterface.can_approve()`
returns False: recognition is probabilistic, and a misheard "yes" against a
destructive action does not come back. Exposing recognition over HTTP would be a
way around that rule, so `/v1/voice/listen` returns *text* and never decides —
every phrase in the table above is a read, a task, or (for open speech) an ask
that can only escalate into a staged, unrun task. Allow / Deny stays on a
human's click, and so does every dispatch to `/v1/tasks`.

## What the glyph is telling you

| State | Look |
|---|---|
| Ade offline | quiet, dim, desaturated to steel |
| Ade idle | slow gold breathing |
| Ade working | burns brighter, particles accelerate |
| A decision waiting on you | turns **amber**, throws arcs, and the chat window raises with the approval card in its Task tab |

That last row is the point of putting it on the desktop. An approval that nobody
sees is an approval that times out, and `WaitingApprover` denies on timeout —
attributed as `timeout`, not as a human decision. The avatar makes the ask
impossible to miss.

## The two kinds of power behind one input

These are **not** equally governed, and the UI says so at the point of use:

- **`/v1/tasks`** — an Ade agent performs the work, so `Permission.check()` runs
  before every destructive tool, the trust tiers apply, and the call is recorded
  in the audit log.
- **`/v1/terminal`** — a direct `subprocess.run`. Ade OS treats this route as
  Ray's own keyboard and **does not consult the gate at all** (see the docstring
  at `adeos/api/app.py:3281`). The Shell tab is labelled
  *"NOT gated by Permission.check()"* permanently — typing into it is always a
  direct subprocess.

The Electron process never spawns a shell of its own. Everything goes over
loopback HTTP to Ade OS, so there is exactly one place where execution happens
and one place to audit it. A second execution path beside the gate is what
`assert_no_bypass()` exists to catch, and adding one would make the gate
decorative.

`preload.js` is the whole attack surface between the renderer and the machine:
no Node in the renderer, no arbitrary URLs, and `main.js` re-checks that every
request path starts with `/v1/`.

## It must not capture what it is not covering

Windows gives a transparent window a **rectangular** hit region. The avatar is
460x568, and measured off `smoke.png` only about **29%** of that rectangle is
painted at all — so the invisible remainder used to swallow every click meant
for the window underneath. Worse, `WS_EX_NOACTIVATE` was unset, so any of those
clicks pulled the foreground into a frameless, `skipTaskbar` window, and nothing
in the app ever handed focus back. Typing afterwards went nowhere. From the
other side of the screen that is indistinguishable from the app underneath
having locked up, and it is what it was reported as.

So the window is click-through by default and only takes the mouse where the
glyph is actually drawn: the renderer alpha-tests the canvas under the cursor
(threshold 48, the point the backing halo has faded out, with a 5px pad so a
one-pixel line is still grabbable) and `applyHit()` in `main.js` acts on it.
Focus follows the same rule — the glyph is **never** keyboard-focusable, so a
click on it can neither trap keystrokes nor steal the foreground from the
window underneath; all typing goes to the conversation window.

`--smoke` asserts both directions, because a click-through window that is also
click-through over its own glyph is just as broken:

| probe | expected |
|---|---|
| `overCorner.ignoresMouse` | `true` — a transparent corner belongs to the window below |
| `overGlyph.ignoresMouse` | `false` — the glyph itself is still grabbable |
| `offAgain.ignoresMouse` | `true` — it lets go again |
| `glyphNotFocusable` | `true` — the glyph is never keyboard-focusable, so it cannot steal the keyboard |

Deleting the fix turns `hit.ok` false and reproduces the two original values
(`TRANSPARENT False`, `NOACTIVATE False`), so the guard is falsified by
breaking the thing it guards rather than passing on its own.

## Transparency

The window is genuinely transparent — frameless, no shadow, no taskbar entry.
Because the glyph is drawn with additive light, it has nothing to accumulate
against on a bare desktop and washes out on a pale wallpaper, so a soft dark
halo sits behind it by default. It fades to fully clear well before the window
edge, so it reads as an orb rather than a panel. Turn it off with **Backing
glow** in the tray menu for pure transparency.

## Layout

| File | |
|---|---|
| `glyph.js` | the renderer — **the single source of truth**, shared with the full-screen page |
| `avatar.html` / `ui.js` | the transparent glyph: drag, mic, hit area, launcher |
| `chat.html` / `chat.js` | the desktop conversation window: tabs, staging, approvals |
| `main.js` | window, tray, polling, and the only door to Ade OS |
| `preload.js` | the narrow bridge |
| `tools/build-artifact.js` | wraps `glyph.js` into the standalone full-screen page |
| `tools/make-icon.js` | generates `icon.png` (no image dependencies) |

`glyph.js` serves both products. Avatar mode is `?avatar=1`: transparent ground,
no cosmic cloud, no starfield, centred framing. Everything else is identical, so
a change to the geometry lands in both. Rebuild the full-screen page with:

```powershell
node tools/build-artifact.js path\to\metatron-resonance.html
```

## Self-check

```powershell
& .\node_modules\electron\dist\electron.exe . --smoke --smoke-wait=9000
```

Loads the window headlessly, asserts it is frameless and always-on-top, counts
lit versus clear pixels to prove the background is really transparent, writes
`smoke.png`, prints what Ade looks like from here, and exits. `clearPixels` must
be non-zero — it was `0` on the first run, which caught the bloom pass writing
alpha across the whole window and making it opaque.

The same run asserts the conversation window: it exists framed and resizable,
stays hidden until opened, draws the Chat / Shell / Task tabs, round-trips its
threads through a temp file, stages escalations without dispatching, drives
approval cards, and relays recognized speech without ever dispatching on
recognition alone. The pure thread-store module has its own unit tests:
`node --test tests/threads-store.test.js`.

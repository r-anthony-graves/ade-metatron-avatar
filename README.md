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
| **Click** the glyph, or **Ctrl+Alt+A** | open the command bar |
| **Right-click** the glyph, or the tray icon | menu: size, opacity, click-through, backing glow, restart Ade, quit |
| **Esc** | hide the command bar |

If you cannot find it, the saved position may be stale from a different monitor
layout. It is now clamped on startup so at least a corner always stays on a
real display, and **Reset position** in the tray menu drops it back to the
bottom-right.

In the command bar, the chip on the left always names what will happen:

| You type | Chip | Where it goes |
|---|---|---|
| `fix the failing test in test_gate.py` | **Task** | `POST /v1/tasks` — an agent does the work |
| `/qa run the trust-level suite` | **Task · qa** | same, with an explicit task type |
| `!git status` | **Shell** | `POST /v1/terminal` — direct subprocess |
| `?what brain are you on` | **Ask** | `POST /v1/chat/completions` |

## Voice

**Ade speaks.** Turn on *Speak Ade's replies* in the tray. Replies come back as
audio from `/v1/voice/speak`, decoded straight from base64 WAV into Web Audio —
no blob URL, so the page keeps its `default-src 'none'` policy. The playing
waveform drives the core, so the glyph is the mouth: fast attack so consonants
land, slower release so it does not strobe between syllables. Asking something
new barges in and cuts off the old answer.

**You speak.** Press the talk hotkey to start listening, the same key to stop,
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
| Command bar | `Ctrl+Alt+A` → `Ctrl+Shift+A` → `Ctrl+Alt+G` |
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
16 kHz mono 16-bit WAV, and posted to `/v1/voice/listen` — Windows' own offline
recogniser. Nothing leaves the machine and nothing is written to disk.

The vocabulary is constrained rather than free dictation, which is both more
reliable and more honest about what can be asked. `GET /v1/voice/phrases`
returns the current list:

| Say | What happens |
|---|---|
| check the health / what are you doing / what is pending | reads Ade's state back |
| list the agents / show the backlog | reads and speaks the answer |
| run the tests | dispatches a task |
| read the file | opens the command bar primed for you to finish typing |
| open the command bar / stop | drives the avatar itself |

### Voice cannot approve anything

Ade OS decided this before the avatar existed and `VoiceInterface.can_approve()`
returns False: recognition is probabilistic, and a misheard "yes" against a
destructive action does not come back. Exposing recognition over HTTP would be a
way around that rule, so `/v1/voice/listen` returns *text* and never decides —
every phrase in the table above is a read or a task. Allow / Deny stays on a
human's click.

## What the glyph is telling you

| State | Look |
|---|---|
| Ade offline | quiet, dim, desaturated to steel |
| Ade idle | slow gold breathing |
| Ade working | burns brighter, particles accelerate |
| A decision waiting on you | turns **amber**, throws arcs, and the command bar opens with Allow / Deny |

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
  at `adeos/api/app.py:3281`). The Shell chip turns amber and the hint line reads
  *"NOT gated by Permission.check()"* whenever you type `!`.

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
Focus follows the same rule — only the command bar has any use for the
keyboard, so only the command bar may take the foreground, and closing it
gives the keyboard back.

`--smoke` asserts both directions, because a click-through window that is also
click-through over its own glyph is just as broken:

| probe | expected |
|---|---|
| `overCorner.ignoresMouse` | `true` — a transparent corner belongs to the window below |
| `overGlyph.ignoresMouse` | `false` — the glyph itself is still grabbable |
| `offAgain.ignoresMouse` | `true` — it lets go again |
| `barClosed.focusable` | `false` — idle, it cannot steal the keyboard |
| `barOpen.focusable` | `true` — open, you can type in it |

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
| `avatar.html` / `ui.js` | the desktop shell: drag, command bar, approvals |
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

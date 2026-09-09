/* The avatar's mood decision core -- renderer-agnostic, ES5.
 *
 * Raw inputs become a mood FRAME the Metatron glyph renders every frame:
 *   - feed(state)   every Ade OS poll picks the resting mood
 *     (offline -> dormant, pending -> attentive, busy -> thinking,
 *      quiet idle -> null: the mode baseline owns the calm).
 *   - event(type)   one-shot impulses: approval decided -> satisfied,
 *     ask failure -> troubled, wake word -> startled.
 *   - tint(inp,ms)  the sentiment of a reply Ade is about to speak; color
 *     only, held for the speech window.
 *   - frame(now)    the live {mood, mode, burst, tint} the glyph reads each
 *     animation frame (same window, same clock -- no extra IPC needed).
 *
 * This file never touches a canvas. It is the ONE avatar renderer file that
 * is a real module: a UMD-lite export lets node:test unit-test the logic,
 * while the pages use the window.ADE_MOOD singleton. */
'use strict';
(function (root) {
  var MODE_DEFAULT = 'auto';
  var BURST_MS = { approved: 1400, failed: 2000, wake: 700 };
  var SHAPE_OF = { startled: 'linear', satisfied: 'swell', troubled: 'linear' };
  var MOOD_OF = { approved: 'satisfied', failed: 'troubled', wake: 'startled' };

  var POS = { good:1, great:2, nice:1, thanks:1, thank:1, love:2, happy:1, glad:1,
    awesome:2, perfect:2, done:1, ready:0.8, welcome:1, works:1, okay:0.8, fine:0.6,
    sure:0.8, please:0.4, yes:1, yep:0.8, help:0.6, better:0.8, solved:1, fixed:1,
    excellent:2, best:1.5, loved:2, amazing:2, relaxing:1 };
  var NEG = { no:-1, nope:-1, bad:-1.2, wrong:-1, error:-1, failed:-1, fail:-1,
    sorry:-1, crash:-1, down:-1, deny:-0.8, denied:-0.8, cannot:-0.8, cant:-0.8,
    stop:-0.6, stuck:-1, broken:-1, unavailable:-0.8, worried:-0.8, troubled:-0.8,
    worse:-1, awful:-1.5, lost:-1, missing:-0.8 };
  var NEGATE = { not:1, never:1, cannot:1, cant:1 };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* A deliberately small lexicon over the reply text: enough to tint a speech
     window, cheap enough to run every reply with zero latency. Strong beats
     mild beats neutral; a negator flips and halves the next 3 tokens. */
  function sentiment(text) {
    var src = String(text == null ? '' : text);
    var hot = (/[A-Z]{3,}|!{2,}/).test(src);
    var words = src.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    var sum = 0, fromNeg = 0, i, w, hit;
    for (i = 0; i < words.length && i < 120; i++) {
      w = words[i];
      hit = POS[w] != null ? POS[w] : (NEG[w] != null ? NEG[w] : 0);
      if (hit !== 0 && fromNeg > 0) hit = -hit * 0.5;
      sum += hit;
      fromNeg = NEGATE[w] ? 3 : Math.max(0, fromNeg - 1);
    }
    return { score: +clamp(sum / 3, -1, 1).toFixed(3), hot: hot };
  }

  function createMood(clockFn) {
    var S = { online: false, busy: false, pending: 0, brain: '' };
    var mode = MODE_DEFAULT;
    var burstMood = null, burstUntil = 0, burstMs = 0;
    var tint = null, tintUntil = 0;

    function now() { return clockFn ? clockFn() : performance.now(); }

    function pickBase() {
      if (!S.online) return 'dormant';
      if (S.pending > 0) return 'attentive';   /* waiting on a human, arcs above */
      if (S.busy) return 'thinking';
      return null;                             /* mode baseline (calm gold) */
    }

    return {
      sentiment: sentiment,

      feed: function (st, modeArg) {
        st = st || {};
        S.online = !!st.online; S.busy = !!st.busy;
        S.pending = st.pending | 0; S.brain = st.brain || '';
        if (typeof modeArg === 'string' && modeArg) mode = modeArg;
        if (typeof st.mode === 'string' && st.mode) mode = st.mode;
      },

      event: function (type, t) {
        if (!type || !MOOD_OF[type]) return;
        var at = t == null ? now() : t;
        burstMood = MOOD_OF[type]; burstMs = BURST_MS[type]; burstUntil = at + burstMs;
      },

      /* inp is a sentiment result {score, hot} or a bare score number. */
      tint: function (inp, ms, t) {
        var obj = inp && typeof inp === 'object' ? inp : { score: +inp || 0, hot: false };
        var sc = +obj.score, hot = !!obj.hot;
        if (!isFinite(sc) || (Math.abs(sc) < 0.08 && !hot)) { tint = null; return; }
        var dur = Math.max(0, Math.min(ms == null ? 4000 : +ms, 8000));
        if (sc < -0.08) tint = { r: 0.92, g: 0.64, b: 0.64, f: 0 };
        else if (sc > 0.08) tint = { r: 1, g: 0.99, b: 0.87, f: hot ? 1 : 0 };
        else tint = { r: 1, g: 0.86, b: 0.55, f: 1 };
        tintUntil = (t == null ? now() : t) + dur;
      },

      frame: function (t) {
        var at = t == null ? now() : t;
        var base = pickBase();
        var moodNow = base, burst = 0;
        if (burstMood && burstUntil > at && base !== 'dormant') {
          moodNow = burstMood;
          var u = clamp((burstUntil - at) / burstMs, 0, 1);
          burst = SHAPE_OF[burstMood] === 'swell' ? Math.sin(Math.PI * u) : u;
        } else {
          burstMood = null;
        }
        var tintNow = null;
        if (tint && at < tintUntil) tintNow = tint; else tint = null;
        return { mood: moodNow, mode: mode, burst: +burst.toFixed(3), tint: tintNow };
      }
    };
  }

  if (typeof window !== 'undefined') window.ADE_MOOD = createMood();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: createMood, sentiment: sentiment };
  }
})(typeof window !== 'undefined' ? window : this);

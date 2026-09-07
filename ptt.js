/* Push-to-talk for the avatar.
 *
 * Captures raw PCM while the key is held, downsamples to 16 kHz mono 16-bit
 * WAV (what System.Speech wants), and posts it to Ade's offline recogniser.
 * No audio leaves the machine and none is written to disk here.
 *
 * VOICE NEVER ANSWERS AN APPROVAL. Ade OS already decided this and the reason
 * is good: recognition is probabilistic, and a misheard "yes" against a
 * destructive action does not come back. Allow/Deny stays on a human's click,
 * so nothing below routes into /v1/approvals/{id}/decide.
 */
'use strict';
window.PTT = (function () {
  var B = window.adeBridge;
  var stream = null, ctx = null, node = null, src = null;
  var chunks = [], rate = 48000, active = false;

  function encodeWav(samples, sampleRate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buf), o = 0;
    function str(s) { for (var i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i)); }
    function u32(v) { view.setUint32(o, v, true); o += 4; }
    function u16(v) { view.setUint16(o, v, true); o += 2; }
    str('RIFF'); u32(36 + samples.length * 2); str('WAVE');
    str('fmt '); u32(16); u16(1); u16(1); u32(sampleRate);
    u32(sampleRate * 2); u16(2); u16(16);
    str('data'); u32(samples.length * 2);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return buf;
  }

  function downsample(input, from, to) {
    if (to >= from) return input;
    var ratio = from / to, out = new Float32Array(Math.floor(input.length / ratio));
    for (var i = 0; i < out.length; i++) {
      var start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
      var sum = 0, n = 0;
      for (var j = start; j < end; j++) { sum += input[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
    return out;
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  async function start(onLevel) {
    if (active) return true;
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      }
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      rate = ctx.sampleRate;
      src = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      chunks = [];
      node.onaudioprocess = function (e) {
        var d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        if (onLevel) {
          var sum = 0;
          for (var i = 0; i < d.length; i++) sum += d[i] * d[i];
          onLevel(Math.min(1, Math.sqrt(sum / d.length) * 5));
        }
      };
      src.connect(node); node.connect(ctx.destination);
      active = true;
      return true;
    } catch (e) {
      active = false;
      return false;
    }
  }

  function teardown() {
    if (node) { try { node.disconnect(); node.onaudioprocess = null; } catch (e) {} node = null; }
    if (src) { try { src.disconnect(); } catch (e) {} src = null; }
    active = false;
  }

  async function stop() {
    if (!active) return { ok: false, error: 'not recording' };
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var all = new Float32Array(total), off = 0;
    for (i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
    chunks = [];
    teardown();

    if (total / rate < 0.25) return { ok: false, error: 'too short' };
    var wav = encodeWav(downsample(all, rate, 16000), 16000);
    var r = await B.call('/v1/voice/listen', 'POST', { audio: toBase64(wav) });
    if (!r || !r.ok) return { ok: false, error: (r && (r.error || 'HTTP ' + r.status)) || 'no reply' };
    return {
      ok: true,
      text: (r.data && r.data.text) || '',
      mode: r.data && r.data.mode,
      engine: r.data && r.data.engine
    };
  }

  /* ------------------------------------------------- always-live mode */
  /* Ray, 2026-08-27: "i need the mic to be live by default with a mute
     button". This REVERSES the invariant stated at the top of
     adeos/voice/__init__.py -- "Push to talk. Nothing is always listening."
     -- and the design doc's non-goal that said the same. Recorded here
     rather than quietly dropped, because the next reader deserves to know
     the rule was overturned on purpose and by whom.

     Two things keep an open microphone honest, and both are load-bearing:

     1. NOTHING IS SENT UNTIL SOMEONE SPEAKS. A voice-activity detector
        segments utterances locally; silence is measured and discarded, never
        transmitted. Audio still leaves this process only for loopback
        recognition, and the buffers are released the moment an utterance
        goes -- `audio is not retained` still holds.
     2. MUTE STOPS THE TRACK. It does not keep capturing and discard the
        results. The OS microphone indicator goes out, because a mute button
        that leaves the mic open is a lie told by a checkbox. */
  var live = { on: false, muted: false, stream: null, ctx: null, src: null, node: null, an: null, gain: null };
  var vadTimer = 0;
  var seg = [], hearing = false, quietMs = 0;
  var SPEECH_RMS = 0.020;      /* below this is room tone, not speech      */
  var HANG_MS    = 400;        /* silence that ends an utterance           */
  /* 700 was most of the wait once the whisper sidecar was running: measured
     2026-08-28, recognition is ~150ms end to end through /v1/voice/listen, so
     the hang was 82% of the dead air after you stop talking. It is not free to
     shorten -- a mid-thought pause longer than this splits one sentence into
     two utterances, and the second half arrives with no wake word and is
     discarded -- so this is the floor, not a number to keep cutting. */
  var MIN_MS     = 300;        /* shorter than this is a cough, not a word */
  var MAX_MS     = 12000;      /* a hard ceiling so one noise cannot grow  */

  function releaseLive() {
    /* the glyph lets go FIRST: it must not be left reading an analyser whose
       stream has stopped, which renders as the piece freezing mid-syllable */
    if (window.GLYPH && window.GLYPH.detachAudio) { try { window.GLYPH.detachAudio(); } catch (e) {} }
    if (vadTimer) { clearInterval(vadTimer); vadTimer = 0; }
    if (live.gain) { try { live.gain.disconnect(); } catch (e) {} live.gain = null; }
    if (live.an) { try { live.an.disconnect(); } catch (e) {} live.an = null; }
    if (live.node) { try { live.node.disconnect(); live.node.onaudioprocess = null; } catch (e) {} live.node = null; }
    if (live.src) { try { live.src.disconnect(); } catch (e) {} live.src = null; }
    if (live.stream) { try { live.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} live.stream = null; }
    seg = []; hearing = false; quietMs = 0;
  }

  var onDispatchCb = null;
  async function sendSegment(onUtterance) {
    var total = 0, i;
    for (i = 0; i < seg.length; i++) total += seg[i].length;
    var all = new Float32Array(total), off = 0;
    for (i = 0; i < seg.length; i++) { all.set(seg[i], off); off += seg[i].length; }
    seg = [];                                  /* released before the await */
    var secs = total / live.rate;
    if (secs * 1000 < MIN_MS) return;
    var wav = encodeWav(downsample(all, live.rate, 16000), 16000);
    /* the caller gets told an utterance is in flight, and told again when it
       lands -- the gap used to be silent from the outside */
    if (onDispatchCb) { try { onDispatchCb(true); } catch (e) {} }
    var r;
    try {
      r = await B.call('/v1/voice/listen', 'POST', { audio: toBase64(wav) });
    } finally {
      if (onDispatchCb) { try { onDispatchCb(false); } catch (e) {} }
    }
    if (!r || !r.ok) return;
    var text = (r.data && r.data.text) || '';
    if (text && onUtterance) onUtterance({ text: text, engine: r.data && r.data.engine, seconds: secs });
  }

  async function resumeLive() {
    if (!live.ctx) return false;
    if (live.ctx.state === 'suspended') {
      try { await live.ctx.resume(); } catch (e) { return false; }
    }
    return live.ctx.state === 'running';
  }

  function liveTracksOk() {
    if (!live.stream) return false;
    var tracks = live.stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].readyState === 'live') return true;
    }
    return false;
  }

  async function openMic() {
    var raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    var stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
    var label = '';
    try { label = (stream.getAudioTracks()[0] || {}).label || ''; } catch (e) {}
    if (label && !/stereo mix|what u hear|wave out|loopback|virtual/i.test(label)) return stream;
    var inputs = [];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) {
        return d.kind === 'audioinput' && d.deviceId && !/stereo mix|what u hear|wave out|loopback|virtual/i.test(d.label || '');
      });
    } catch (e) { return stream; }
    var prefer = inputs.filter(function (d) { return /yeti|headset|array|usb/i.test(d.label || ''); });
    var pick = prefer[0] || inputs[0];
    if (!pick) return stream;
    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    raw.deviceId = { exact: pick.deviceId };
    return navigator.mediaDevices.getUserMedia({ audio: raw });
  }

  async function startLive(onUtterance, onLevel, onDispatch) {
    if (live.on && !live.muted && liveTracksOk()) {
      await resumeLive();
      if (window.GLYPH && window.GLYPH.attachAudio && live.an) {
        window.GLYPH.attachAudio(live.an, live.rate);
      }
      return !live.ctx || live.ctx.state !== 'suspended';
    }
    onDispatchCb = onDispatch || null;
    try {
      /* Raw capture, same constraints glyph.js arm() uses. Voice-activity
         reads the analyser on an interval -- ScriptProcessor is deprecated
         and we do not need it as a second speaker tap. */
      live.stream = await openMic();
      if (!live.ctx) live.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (live.ctx.state === 'suspended') await live.ctx.resume();
      live.rate = live.ctx.sampleRate;
      live.src = live.ctx.createMediaStreamSource(live.stream);
      live.an = live.ctx.createAnalyser();
      live.an.fftSize = 2048;
      live.an.smoothingTimeConstant = 0.5;
      live.an.minDecibels = -96;
      live.an.maxDecibels = -12;
      live.src.connect(live.an);
      /* Analyser is a tap; without a destination pull Chromium can leave
         the graph unprocessed and getFloatTimeDomainData stays zeros. */
      live.gain = live.ctx.createGain();
      live.gain.gain.value = 0;
      live.an.connect(live.gain);
      live.gain.connect(live.ctx.destination);
      if (window.GLYPH && window.GLYPH.attachAudio) {
        window.GLYPH.attachAudio(live.an, live.ctx.sampleRate);
      }
      if (vadTimer) { clearInterval(vadTimer); vadTimer = 0; }
      var td = new Float32Array(live.an.fftSize);
      var bufMs = 50;
      vadTimer = setInterval(function () {
        if (!live.an || live.muted) return;
        live.an.getFloatTimeDomainData(td);
        var sum = 0, i;
        for (i = 0; i < td.length; i++) sum += td[i] * td[i];
        var rms = Math.sqrt(sum / td.length);
        live.lastRms = rms;
        live.procAt = Date.now();
        if (onLevel) onLevel(Math.min(1, rms * 5));
        if (rms >= SPEECH_RMS) {
          hearing = true; quietMs = 0;
          seg.push(new Float32Array(td));
        } else if (hearing) {
          quietMs += bufMs;
          seg.push(new Float32Array(td));
          if (quietMs >= HANG_MS) { hearing = false; quietMs = 0; sendSegment(onUtterance); }
        }
        if (hearing && seg.length * bufMs > MAX_MS) { hearing = false; quietMs = 0; sendSegment(onUtterance); }
      }, bufMs);
      live.on = true; live.muted = false;
      return true;
    } catch (e) {
      live.lastError = String((e && e.message) || e);
      releaseLive(); live.on = false;
      return false;
    }
  }

  function muteLive() {
    releaseLive();                 /* the track is STOPPED, not ignored */
    live.muted = true;
    return true;
  }

  return {
    start: start, stop: stop, isActive: function () { return active; },
    live: startLive, mute: muteLive,
    isLive: function () { return live.on && !live.muted && liveTracksOk(); },
    isMuted: function () { return !!live.muted; },
    resume: resumeLive,
    /* --smoke reaches in here to prove mute really stops the track */
    _tracks: function () { return live.stream ? live.stream.getTracks().length : 0; },
    _audioState: function () {
      return {
        on: !!live.on,
        muted: !!live.muted,
        ctx: live.ctx ? live.ctx.state : null,
        rate: live.rate || 0,
        hasAnalyser: !!live.an,
        hasVad: !!vadTimer,
        lastRms: live.lastRms || 0,
        procAgeMs: live.procAt ? (Date.now() - live.procAt) : null,
        lastError: live.lastError || null,
        tracks: live.stream ? live.stream.getTracks().map(function (t) {
          var s = {};
          try { s = t.getSettings ? t.getSettings() : {}; } catch (e) {}
          return {
            state: t.readyState, muted: !!t.muted, enabled: t.enabled,
            label: t.label || '', deviceId: s.deviceId || '',
            groupId: s.groupId || '', channelCount: s.channelCount,
            sampleRate: s.sampleRate
          };
        }) : []
      };
    }
  };
})();

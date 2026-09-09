
(function(){
'use strict';

/* ---------------------------------------------------------------- utility */
var TAU = Math.PI*2, CYCLE = 24;

/* Desktop-avatar mode: no ground, no cloud, no starfield -- the glyph alone on
   a transparent window. Set by ?avatar=1 (Electron) or window.GLYPH_AVATAR. */
var AVATAR = (typeof location !== 'undefined' && /[?&]avatar=1/.test(location.search))
          || (typeof window !== 'undefined' && !!window.GLYPH_AVATAR);
var stage = document.getElementById('stage') || document.body;
var cvs   = document.getElementById('glyph');
var ctx   = cvs.getContext('2d', { alpha: AVATAR });
var q1=document.createElement('canvas'), q2=document.createElement('canvas'), h1=document.createElement('canvas');
var g1=q1.getContext('2d'), g2=q2.getContext('2d'), gh=h1.getContext('2d');

var W=0,H=0,DPR=1,CX=0,CY=0,S=1,PX=1;

function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function lerp(a,b,t){ return a+(b-a)*t; }
function ss(a,b,x){ var t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); }
function easeOut(x){ var k=1-x; return 1-k*k*k; }
function rng(seed){ var a=seed>>>0; return function(){ a=a+0x6D2B79F5|0; var t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

/* Warm inks on light steel grey. On a pale ground energy reads as saturated
   pigment, not as added light, so the structure is composited normally and the
   names keep their ROLE rather than their old hue: BLUE is now the receding
   deep red, GOLDH the hottest highlight. LIGHT switches the compositing model;
   set it false to put the same warm palette back on a dark ground. */
var LIGHT = true;
var BLEND = LIGHT ? 'source-over' : 'lighter';

var GOLD=[239,122,30],  GOLDH=[247,206,62], BLUE=[142,27,42], BLUEH=[224,74,30],
    WHITE=[255,244,214], CYAN=[245,166,35], STEEL=[122,130,142];
/* The palette above is warm end to end -- CYAN is orange, BLUE is a deep red --
   and the two cool tones already carry meanings: STEEL is "Ade is offline" and
   ALERT is "a decision is waiting". Hearing you needed a tone of its own rather
   than a borrowed one, so this is the only genuinely cool colour in the piece and
   it means exactly one thing: your voice is arriving. */
var LISTEN=[86,196,214], LISTENH=[176,240,248];
var GROUND=['#c3c9d2','#b5bcc7','#a9b0bc'];

function rgba(c,a){ a = a<0?0:(a>1?1:a); return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a.toFixed(3)+')'; }
function mix(a,b,t){ return [ (a[0]+(b[0]-a[0])*t)|0, (a[1]+(b[1]-a[1])*t)|0, (a[2]+(b[2]-a[2])*t)|0 ]; }

function sprite(c){
  var s=64, cv=document.createElement('canvas'); cv.width=cv.height=s;
  var g=cv.getContext('2d'), rg=g.createRadialGradient(32,32,0,32,32,32);
  rg.addColorStop(0,rgba(c,1)); rg.addColorStop(0.16,rgba(c,0.66));
  rg.addColorStop(0.42,rgba(c,0.17)); rg.addColorStop(1,rgba(c,0));
  g.fillStyle=rg; g.fillRect(0,0,s,s); return cv;
}
var SP_GOLD=sprite(GOLD), SP_BLUE=sprite(BLUE), SP_WHITE=sprite(WHITE), SP_CYAN=sprite(CYAN);
var SP_LISTEN=null;   /* built lazily: LISTEN is declared below the palette */

function dot(sp,x,y,r,a){ if(a<=0.004||r<=0.06) return; ctx.globalAlpha=a; ctx.drawImage(sp,x-r,y-r,r*2,r*2); }

/* ------------------------------------------------------- what Ade is doing */
/* The avatar is a readout as well as a control surface: offline it goes quiet
   and grey, working it burns, and a decision waiting on a human turns it amber
   and starts throwing arcs until somebody answers. */
var ALERT=[178,18,43];        /* crimson: the one signal that must not blend in */
var ADE = { online:false, busy:false, pending:0, brain:'', res:0.10, alert:0, spark:0, backing:true,
            speaking:0, speak:0, hearing:0, hear:0, micLit:0 };
ADE.apply = function(st){
  this.online = !!st.online; this.busy = !!st.busy;
  this.pending = st.pending|0; this.brain = st.brain||'';
};
ADE.step = function(dt){
  var target = !this.online ? 0.04
    : (MOOD.mood ? MOODS[MOOD.mood].res
       : (this.pending > 0 ? 0.94 : (this.busy ? 0.74 : 0.22)));
  this.res += (target - this.res) * (1 - Math.exp(-dt/0.85));
  /* the spoken waveform is the avatar's mouth: fast attack so consonants land,
     slower release so it does not strobe between syllables */
  var sp = this.speak;
  this.speaking += (sp - this.speaking) * (1 - Math.exp(-dt/(sp > this.speaking ? 0.035 : 0.13)));
  this.alert += ((this.pending>0 ? 1 : 0) - this.alert) * (1 - Math.exp(-dt/0.35));
  /* YOUR voice, on a channel of its own. One channel carrying both is what made
     being heard indistinguishable from being talked at: the microphone level and
     Ade's own speech waveform were both arriving through setSpeaking(). Same
     envelope shape as the mouth above -- fast attack so a word registers the
     moment it starts -- with a slightly longer release, because the eye reads a
     listener as steady and a talker as percussive. */
  var hr = this.hear;
  this.hearing += (hr - this.hearing) * (1 - Math.exp(-dt/(hr > this.hearing ? 0.030 : 0.16)));
  /* and whether the track is open at all, faded rather than switched so it
     never blinks on an incidental mute */
  this.micLit += ((MIC_OPEN ? 1 : 0) - this.micLit) * (1 - Math.exp(-dt/0.10));
};

/* -------------------------------------------------------------- moods */
/* A mood names the SHAPE Ade's ground truth takes this moment. Raw state and
   events decide it (mood.js); the renderer only owns the look. MOODS is the
   per-mood palette + motion; MOOD holds the live frame the rAF loop pulls.
   With no mood active the orb renders exactly as it always has. */
var MOODS = {
  dormant:   { res: 0.05, hot: STEEL,     mid: STEEL,     halo: STEEL,  breathe: 0.10, spiral: 0.0 },
  attentive: { res: 0.35, hot: LISTENH,   mid: LISTEN,    halo: LISTEN, breathe: 0.22, spiral: 0.6 },
  thinking:  { res: 0.80, hot: GOLDH,     mid: GOLD,      halo: GOLD,   breathe: 0.28, spiral: 1.6 },
  speaking:  { res: 0.62, hot: GOLDH,     mid: GOLD,      halo: GOLD,   breathe: 0.30, spiral: 0.6 },
  satisfied: { res: 0.55, hot: GOLDH,     mid: GOLD,      halo: GOLD,   breathe: 0.18, spiral: 0.3 },
  startled:  { res: 0.90, hot: WHITE,     mid: GOLDH,     halo: WHITE,  breathe: 0.60, spiral: 0.9 },
  troubled:  { res: 0.18, hot: ALERT,     mid: STEEL,     halo: ALERT,  breathe: 0.30, spiral: 0.15 }
};
var MOOD = { mood: null, mode: 'auto', burst: 0, tint: null, flick: 0,
             hot: GOLDH, mid: GOLD, halo: GOLD, ambient: 0, ember: 0 };
function mul3(c, tt) {
  return [clamp(c[0] * tt.r, 0, 255), clamp(c[1] * tt.g, 0, 255), clamp(c[2] * tt.b, 0, 255)];
}
function moodPalette() {
  var m = MOOD.mood && MOODS[MOOD.mood];
  if (!m || !MOOD.tint) { MOOD.hot = m ? m.hot : GOLDH; MOOD.mid = m ? m.mid : GOLD; MOOD.halo = m ? m.halo : GOLD; return; }
  var k = m ? MOOD.burst : 0;
  MOOD.hot  = mul3(mix(m.hot,  WHITE, k * 0.55), MOOD.tint);
  MOOD.mid  = mul3(mix(m.mid,  GOLDH, k * 0.35), MOOD.tint);
  MOOD.halo = mul3(mix(m.halo, WHITE, k * 0.40), MOOD.tint);
}
function pullMood() {
  if (window.ADE_MOOD && window.ADE_MOOD.frame) {
    var f = window.ADE_MOOD.frame(performance.now());
    if (!f || !MOODS[f.mood]) { MOOD.mood = null; MOOD.burst = 0; MOOD.tint = null; }
    else {
      MOOD.mood = f.mood; MOOD.mode = f.mode || 'auto';
      MOOD.burst = clamp(f.burst || 0, 0, 1);
      MOOD.tint = f.tint || null; MOOD.flick = MOOD.tint ? (MOOD.tint.f ? 1 : 0) : 0;
    }
  } else { MOOD.mood = null; MOOD.burst = 0; MOOD.tint = null; }
  moodPalette();
}

/* -------------------------------------------------- arming, without chrome */
/* No button and no readout: the microphone is offered on load and, if the
   browser wants a gesture first, on the next pointer or key event anywhere.
   Refused, the piece simply keeps running its own storyboard. */
var micStatus = 'idle';
function micState(state){ micStatus = state; }
function tryArm(){ if(!AUDIO.on && micStatus !== 'busy') AUDIO.arm(); }

/* ------------------------------------------------------------- the voice */
/* When armed, the microphone drives the field: loudness becomes resonance,
   the five spectral bands become the five shells, and the detected pitch
   becomes f_res -- so the capacitance the tank needs is solved live from
   L and your voice, C = 1 / (L (2*pi*f)^2). */
var AUDIO = {
  on:false, ctx:null, an:null, stream:null, sr:48000, tick:0,
  td:null, fd:null, prev:null, dec:null, nsdf:null,
  level:0, env:0, peak:0.02, res:0.08, phase:0,
  pitch:0, voiced:0, hold:0, tone:0.42,
  bands:[0,0,0,0,0], bpeak:[0.05,0.05,0.05,0.05,0.05],
  flux:0, fluxAvg:0, onset:0, lock:0, flash:0
};

AUDIO.arm = function(){
  var self=this;
  var md = navigator.mediaDevices;
  if(!md || !md.getUserMedia){
    micState('error','Listen','No microphone available in this frame — open the page in its own tab');
    return;
  }
  micState('busy','Waiting','Allow microphone access to continue');
  /* a prompt that is never answered must not strand the control */
  var settled = false;
  var watchdog = setTimeout(function(){
    if(!settled && !self.on) micState('error','Retry','No answer from the microphone prompt — check the site permissions in your browser');
  }, 20000);
  md.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } })
  .then(function(stream){
    settled = true; clearTimeout(watchdog);
    var AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) throw new Error('no web audio');
    var ac = new AC();
    if(ac.state === 'suspended') ac.resume();
    var an = ac.createAnalyser();
    an.fftSize = 2048; an.smoothingTimeConstant = 0.5;
    an.minDecibels = -96; an.maxDecibels = -12;
    ac.createMediaStreamSource(stream).connect(an);
    self.ctx=ac; self.an=an; self.stream=stream; self.sr=ac.sampleRate;
    self.td   = new Float32Array(an.fftSize);
    self.fd   = new Uint8Array(an.frequencyBinCount);
    self.prev = new Uint8Array(an.frequencyBinCount);
    self.dec  = new Float32Array(an.fftSize>>2);
    self.nsdf = new Float32Array((an.fftSize>>2)+2);
    self.on = true;
    micState('live','Listening','Speak or sing — pitch sets f_res');
  })
  .catch(function(e){
    settled = true; clearTimeout(watchdog);
    var name = e && e.name;
    var msg = (name==='NotAllowedError' || name==='SecurityError')
      ? 'Microphone blocked — allow access in your browser, then try again'
      : (name==='NotFoundError' ? 'No microphone found on this device'
                                : 'Microphone unavailable: ' + ((e && e.message) || name || 'unknown'));
    micState('error','Retry', msg);
  });
};

/* The avatar does NOT arm its own microphone. ptt.js already holds one open for
   recognition, and a second getUserMedia would be a second capture of the same
   device -- two entries in the OS microphone indicator for one act of speaking.
   So the avatar hands in an AnalyserNode on the stream it already owns, and
   sample() below runs unchanged: the loudness envelope, the five band peaks,
   the flux onset detector and the pitch tracker are the piece's own and are not
   worth reinventing on the other side of the bridge.

   detach() is NOT disarm(): disarm stops the tracks, and those tracks belong to
   ptt.js. Muting the microphone is ptt.js's job and it does it by stopping the
   track; this only lets go of the analyser. */
AUDIO.attach = function(an, sr){
  this.an = an; this.sr = sr || this.sr;
  this.td   = new Float32Array(an.fftSize);
  this.fd   = new Uint8Array(an.frequencyBinCount);
  this.prev = new Uint8Array(an.frequencyBinCount);
  this.dec  = new Float32Array(an.fftSize>>2);
  this.nsdf = new Float32Array((an.fftSize>>2)+2);
  this.on = true;
};

AUDIO.detach = function(){
  this.on = false; this.an = null;
  this.level=0; this.env=0; this.res=0; this.flash=0; this.onset=0; this.voiced=0; this.pitch=0;
  for(var b=0;b<5;b++){ this.bands[b]=0; this.bpeak[b]=0.05; }
};

AUDIO.disarm = function(){
  this.on = false;
  if(this.stream){ var tr=this.stream.getTracks(); for(var i=0;i<tr.length;i++) tr[i].stop(); }
  if(this.ctx && this.ctx.close) { try { this.ctx.close(); } catch(e){} }
  this.stream=null; this.ctx=null; this.an=null;
  this.level=0; this.env=0; this.voiced=0; this.pitch=0;
  for(var b=0;b<5;b++){ this.bands[b]=0; this.bpeak[b]=0.05; }
  micState('idle','Listen','Speak or sing to drive the resonance');
};

var BAND_EDGES=[60,180,420,1200,3200,9000];   /* chest, body, vowel, presence, air */

AUDIO.sample = function(dt){
  var an=this.an; if(!an) return;
  an.getFloatTimeDomainData(this.td);
  an.getByteFrequencyData(this.fd);
  var td=this.td, N=td.length, i, acc=0;

  /* loudness, with a slowly-decaying reference so a quiet voice still fills the scale */
  for(i=0;i<N;i++) acc += td[i]*td[i];
  var rms = Math.sqrt(acc/N);
  this.peak = Math.max(rms, this.peak*(1 - dt*0.32));
  var lv = rms < 0.0032 ? 0 : Math.pow(clamp(rms/Math.max(0.014,this.peak),0,1), 0.62);
  this.level += (lv - this.level) * (1 - Math.exp(-dt/(lv>this.level ? 0.035 : 0.20)));
  this.env   += (this.level - this.env) * (1 - Math.exp(-dt/1.10));

  /* five bands -> five shells */
  var fd=this.fd, bw=(this.sr/2)/fd.length;
  for(var b=0;b<5;b++){
    var i0=Math.max(1,(BAND_EDGES[b]/bw)|0), i1=Math.min(fd.length-1,(BAND_EDGES[b+1]/bw)|0);
    var sum=0, cnt=0;
    for(i=i0;i<=i1;i++){ sum+=fd[i]; cnt++; }
    var v = cnt ? sum/cnt/255 : 0;
    this.bpeak[b] = Math.max(v, this.bpeak[b]*(1 - dt*0.28));
    var nv = Math.pow(clamp(v/Math.max(0.055,this.bpeak[b]),0,1), 0.85) * this.level;
    this.bands[b] += (nv - this.bands[b]) * (1 - Math.exp(-dt/(nv>this.bands[b] ? 0.030 : 0.17)));
  }

  /* spectral flux -> consonants and transients throw arcs */
  var fl=0, prev=this.prev;
  for(i=2;i<fd.length;i++){ var d0=fd[i]-prev[i]; if(d0>0) fl+=d0; prev[i]=fd[i]; }
  fl /= (fd.length*255);
  this.fluxAvg += (fl - this.fluxAvg) * clamp(dt*3.2,0,1);
  this.onset = 0; this.lock -= dt;
  if(fl > this.fluxAvg*2.1 + 0.005 && this.level > 0.13 && this.lock <= 0){
    this.onset = 1; this.lock = 0.085; this.flash = 1;
  }
  this.flash *= Math.exp(-dt/0.17);

  /* pitch, every other frame: normalised autocorrelation on a 4x-decimated frame */
  this.tick++;
  if((this.tick & 1) === 0 && this.level > 0.07) this.detect(dt);
  this.hold -= dt;
  if(this.hold <= 0) this.voiced *= Math.exp(-dt/0.28);

  /* what you sing, not just how loudly: pitch becomes the core's colour
     temperature and the rate it breathes at */
  var tn = clamp(Math.log(clamp(this.pitch||160, 70, 500)/70)/Math.log(500/70), 0, 1);
  this.tone += (tn - this.tone) * (1 - Math.exp(-dt/0.18));

  this.res  = clamp(0.055 + 0.945*Math.pow(this.level,0.88), 0.05, 1);
  this.phase += dt * (0.018 + 0.170*this.level);
};

AUDIO.detect = function(dt){
  var td=this.td, x=this.dec, M=x.length, i;
  for(i=0;i<M;i++){ var j=i<<2; x[i]=(td[j]+td[j+1]+td[j+2]+td[j+3])*0.25; }
  var sr=this.sr/4, mean=0;
  for(i=0;i<M;i++) mean+=x[i];
  mean/=M;
  var pw=0;
  for(i=0;i<M;i++){ x[i]-=mean; pw+=x[i]*x[i]; }
  if(pw/M < 1e-7) return;

  var minL=Math.max(2,Math.floor(sr/520)), maxL=Math.min(M-2, Math.floor(sr/68));
  var vals=this.nsdf, best=0, bestL=0, lag;
  for(lag=minL; lag<=maxL; lag++){
    var c=0, e=0;
    for(i=0;i<M-lag;i++){ var a0=x[i], a1=x[i+lag]; c+=a0*a1; e+=a0*a0+a1*a1; }
    var n = e>0 ? 2*c/e : 0;
    vals[lag]=n;
    if(n>best){ best=n; bestL=lag; }
  }
  if(best < 0.42) return;

  /* take the earliest strong peak, not the tallest — that is the octave guard */
  var thr=0.86*best, chosen=bestL;
  for(lag=minL+1; lag<maxL; lag++){
    if(vals[lag]>thr && vals[lag]>=vals[lag-1] && vals[lag]>=vals[lag+1]){ chosen=lag; break; }
  }
  var y0=vals[chosen-1]||0, y1=vals[chosen], y2=vals[chosen+1]||0, den=y0-2*y1+y2;
  var f = sr/(chosen + (den!==0 ? 0.5*(y0-y2)/den : 0));
  if(f>62 && f<520){
    this.pitch = this.pitch>0 ? this.pitch + (f-this.pitch)*(1-Math.exp(-dt/0.055)) : f;
    this.voiced = 1; this.hold = 0.32;
  }
};

/* ------------------------------------------------- the master time bases */
/* flow(t): monotonic 0..1 over one cycle, du/dt peaks at t=18s (max resonance).
   flow(0)=0 and flow(24)=1 exactly, so every phase built on it loops seamlessly. */
var FLOW_K = 0.74, W0 = TAU/CYCLE, FLOW_OFF = Math.sin(W0*(-18));
function flow(t){ return t/CYCLE + (FLOW_K/TAU)*(Math.sin(W0*(t-18)) - FLOW_OFF); }

/* resonance envelope — the 0..24s storyboard, wrapping to itself */
var KEYS=[[0,0.06],[3,0.14],[7,0.30],[12,0.52],[16,0.86],[18,1.00],[20,0.93],[22,0.44],[24,0.06]];
function resonance(t){
  for(var i=0;i<KEYS.length-1;i++){
    if(t>=KEYS[i][0] && t<=KEYS[i+1][0]){
      return lerp(KEYS[i][1], KEYS[i+1][1], ss(KEYS[i][0],KEYS[i+1][0],t));
    }
  }
  return KEYS[0][1];
}
/* assembly — particles condense into the glyph 0-3s, release 22.4-24s (the loop seam) */
function assembly(t){ return Math.min(ss(0,3,t), 1-ss(22.4,24,t)); }

/* ------------------------------------------------------------- geometry */
var R = 1.0, PLANE_TILT = 0.22;
function rotX(p,a){ var c=Math.cos(a),s=Math.sin(a); return [p[0], p[1]*c - p[2]*s, p[1]*s + p[2]*c]; }

var nodes=[], NR=rng(90210);
function pushNode(p,kind,k){
  nodes.push({ p:rotX(p,PLANE_TILT), kind:kind, k:k,
               sc:[(NR()-0.5)*2.6,(NR()-0.5)*2.6,(NR()-0.5)*2.6], delay:NR()*0.55 });
}
pushNode([0,0,0],'core',-1);
for(var k=0;k<6;k++){ var a=-Math.PI/2+k*Math.PI/3; pushNode([Math.cos(a)*R, Math.sin(a)*R, 0],'inner',k); }
for(var k2=0;k2<6;k2++){ var a2=-Math.PI/2+k2*Math.PI/3; pushNode([Math.cos(a2)*2*R, Math.sin(a2)*2*R, 0],'outer',k2); }
var IN=function(k){ return 1+((k%6)+6)%6; }, OUT=function(k){ return 7+((k%6)+6)%6; };

/* the 60 non-degenerate edges of Metatron's Cube (collinear duplicates through
   the core are dropped so the spokes don't stack into a hot bar) */
var edges=[];
function E(a,b,w,c){ edges.push({a:a,b:b,w:w,c:c}); }
for(var k3=0;k3<6;k3++){
  E(0, IN(k3), 1.00, GOLD);
  E(IN(k3), OUT(k3), 0.92, GOLD);
  E(IN(k3), IN(k3+1), 0.74, mix(GOLD,BLUE,0.45));
  E(OUT(k3), OUT(k3+1), 0.74, mix(GOLD,BLUE,0.45));
  E(IN(k3), IN(k3+2), 0.52, BLUE);
  E(OUT(k3), OUT(k3+2), 0.52, BLUE);
  E(IN(k3), OUT(k3+1), 0.34, BLUE);
  E(IN(k3), OUT(k3-1), 0.34, BLUE);
  E(IN(k3), OUT(k3+2), 0.24, BLUE);
  E(IN(k3), OUT(k3-2), 0.24, BLUE);
}

/* the thirteen circles — the Fruit of Life underlay */
var circles=[];
for(var n=0;n<nodes.length;n++){
  var pts=[], cp=nodes[n].p;
  for(var s2=0;s2<=36;s2++){
    var ang=s2/36*TAU, lp=rotX([Math.cos(ang)*R*0.5, Math.sin(ang)*R*0.5, 0], PLANE_TILT);
    pts.push([cp[0]+lp[0], cp[1]+lp[1], cp[2]+lp[2]]);
  }
  circles.push(pts);
}

/* nested polyhedra — the solids Metatron's Cube encodes */
var OCT_V=[[1.18,0,0],[-1.18,0,0],[0,1.18,0],[0,-1.18,0],[0,0,1.18],[0,0,-1.18]];
var OCT_E=[[0,2],[0,3],[0,4],[0,5],[1,2],[1,3],[1,4],[1,5],[2,4],[2,5],[3,4],[3,5]];
var cc=0.70, CUB_V=[[cc,cc,cc],[cc,cc,-cc],[cc,-cc,cc],[cc,-cc,-cc],[-cc,cc,cc],[-cc,cc,-cc],[-cc,-cc,cc],[-cc,-cc,-cc]];
var CUB_E=[[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];
var mm=0.88;
var TET_A=[[mm,mm,mm],[mm,-mm,-mm],[-mm,mm,-mm],[-mm,-mm,mm]];
var TET_B=[[-mm,-mm,-mm],[-mm,mm,mm],[mm,-mm,mm],[mm,mm,-mm]];
var TET_E=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];

/* five orbital shells, outermost to innermost */
var RINGS=[
  { r:3.06, tx: 0.18, tz: 0.09, turns:-2, col:BLUE },
  { r:2.62, tx:-0.58, tz: 0.30, turns: 3, col:mix(BLUE,GOLD,0.30) },
  { r:2.20, tx: 0.98, tz:-0.36, turns:-4, col:mix(BLUE,GOLD,0.55) },
  { r:1.78, tx:-1.16, tz: 0.58, turns: 5, col:mix(BLUE,GOLD,0.75) },
  { r:1.42, tx: 1.34, tz:-0.22, turns:-7, col:GOLD }
];
for(var ri=0;ri<RINGS.length;ri++){
  var rr=RINGS[ri], pts2=[];
  for(var si=0;si<=108;si++) pts2.push(si/108*TAU);
  rr.angles=pts2; rr.proj=new Array(pts2.length);
}

/* --------------------------------------------------- camera & projection */
var sgG=0,cgG=1, syC=0,cyC=1, spC=0,cpC=1, srC=0,crC=1, camD=9.6, focal=900;
var WORLD_R = 3.3;

function setCamera(t, res){
  var ph = TAU*t/CYCLE;
  var gRot = ph - 1.0472;                          /* 360 deg per cycle, phased so the 16-20s
                                                      peak lands face-on, then three-quarter */
  var yaw  = 0.50*Math.sin(ph);                    /* slow cinematic arc, loops exactly    */
  var pit  = 0.17 + 0.115*Math.sin(ph + 2.0);
  var roll = 0.022*Math.sin(ph*2 + 0.7);
  camD = 9.6 + 0.72*Math.sin(ph + 0.6) - 0.5*res;  /* it leans in as resonance builds */
  sgG=Math.sin(gRot); cgG=Math.cos(gRot);
  syC=Math.sin(yaw);  cyC=Math.cos(yaw);
  spC=Math.sin(pit);  cpC=Math.cos(pit);
  srC=Math.sin(roll); crC=Math.cos(roll);
  focal = PX * camD / WORLD_R;
}

function xf(p, spin, noSpin){
  var x=p[0], y=p[1], z=p[2], nx, nz, ny;
  if(spin){ var s0=Math.sin(spin), c0=Math.cos(spin); nx=x*c0+z*s0; nz=-x*s0+z*c0; x=nx; z=nz; }
  if(!noSpin){ nx=x*cgG+z*sgG; nz=-x*sgG+z*cgG; x=nx; z=nz; }
  nx=x*cyC+z*syC; nz=-x*syC+z*cyC; x=nx; z=nz;
  ny=y*cpC-z*spC; nz=y*spC+z*cpC; y=ny; z=nz;
  return [x, y, z+camD];
}
var _p={x:0,y:0,s:1,z:1,d:0.5};
var POOL=[], POOLI=0;
function tmp(){ if(POOLI>=POOL.length) POOL.push({x:0,y:0,s:1,z:1,d:0.5}); return POOL[POOLI++]; }
function proj(v, out){
  var o = out || _p, z = v[2] < 0.35 ? 0.35 : v[2], f = focal/z;
  var dx = v[0]*f, dy = -v[1]*f;
  if(srC){ var nx=dx*crC-dy*srC, ny=dx*srC+dy*crC; dx=nx; dy=ny; }
  o.x = CX+dx; o.y = CY+dy; o.s = f; o.z = z;
  o.d = clamp((camD + WORLD_R - z)/(2*WORLD_R), 0, 1);   /* 1 = nearest the lens */
  return o;
}
function P(p, spin, noSpin, out){ return proj(xf(p,spin,noSpin), out); }

/* ------------------------------------------------------- the cosmic cloud */
/* Three translucent gas layers, each its own domain-warped noise field with a
   real alpha channel, drawn additively and oversized so they run past every
   edge. Stars are painted between the layers, so some of them shine through
   the gas and some sit behind it -- that is what makes it read as volume
   rather than as a picture of a nebula hung on the wall. */
var NSZ=256, NTAB=new Float32Array(NSZ*NSZ);
(function(){ var r=rng(20260822); for(var i=0;i<NSZ*NSZ;i++) NTAB[i]=r(); })();

function vn(x,y){
  var xi=Math.floor(x), yi=Math.floor(y), xf=x-xi, yf=y-yi;
  var u=xf*xf*(3-2*xf), v=yf*yf*(3-2*yf);
  var x0=xi&255, x1=(xi+1)&255, y0=(yi&255)*NSZ, y1=((yi+1)&255)*NSZ;
  var a=NTAB[y0+x0], b=NTAB[y0+x1], c=NTAB[y1+x0], e=NTAB[y1+x1];
  var t0=a+(b-a)*u, t1=c+(e-c)*u;
  return t0+(t1-t0)*v;
}
function fbm(x,y,oct){
  var s=0, amp=0.5, f=1;
  for(var i=0;i<oct;i++){ s+=amp*vn(x*f,y*f); f*=2.03; amp*=0.5; }
  return s;
}

var CLOUD=[
  { seed: 3.1, scale:0.85, tint:[176,150,132], warm:0.52, a:0.30, par:0.014, drift: 0.005, over:1.34 },
  { seed:17.7, scale:1.55, tint:[186,124, 96], warm:0.62, a:0.24, par:0.030, drift:-0.008, over:1.28 },
  { seed:41.3, scale:2.70, tint:[198,108, 62], warm:0.80, a:0.19, par:0.052, drift: 0.012, over:1.23 }
];

/* Layers are cheap on purpose: each is blown up five to ten times on screen,
   so gas wants low resolution and few octaves, not detail. One layer is built
   per frame, which keeps the first paint immediate instead of stalling on it. */
var cloudQueue=[], cloudW=0;
function requestCloud(){
  var w = Math.round(clamp(W*0.22, 150, 260));
  if(w === cloudW && CLOUD[2].cv) return;
  cloudW = w; cloudQueue = [0,1,2];
}
function buildCloudStep(){
  if(!cloudQueue.length) return;
  buildLayer(cloudQueue.shift());
}
var LAYER_RES=[0.55, 0.78, 1.00];
function buildLayer(idx){
  var c=CLOUD[idx];
  var w=Math.max(96, Math.round(cloudW*LAYER_RES[idx]));
  var h=Math.max(72, Math.round(clamp(w*H/W, 60, 460)));
  c.cv = c.cv || document.createElement('canvas');
  c.cv.width=w; c.cv.height=h;
  var g=c.cv.getContext('2d'), img=g.createImageData(w,h), d=img.data, i=0;
  var sc=2.7*c.scale/w, o=c.seed*13.7, tr=c.tint[0], tg=c.tint[1], tb=c.tint[2];
  for(var y=0;y<h;y++){
    for(var x=0;x<w;x++){
      var px=x*sc+o, py=y*sc+o*0.61;
      var wp=fbm(px*0.90+11.3, py*0.90+4.7, 2);      /* one warp field, used twice */
      var base=fbm(px+wp*2.3, py+wp*1.7+5.9, 3);
      var mask=vn(px*0.31+70.5, py*0.31+13.9);
      var dens=clamp((base*1.62-0.44)*(0.22+1.60*mask), 0, 1);
      dens=dens*dens*(1.45-0.45*dens);
      var lane=clamp((fbm(px*1.40+200.0, py*1.40+90.0, 2)-0.50)*2.4, 0, 1);
      dens *= 1 - 0.62*lane;                         /* dust lanes carve it open */
      var hot=clamp(fbm(px*2.05+300.0, py*2.05+150.0, 2)*1.5-0.58, 0, 1);
      hot = hot*hot*dens;
      var b=Math.pow(clamp(dens*1.10 + hot*1.30, 0, 1), 2.1)*c.warm;
      d[i++] = tr + (255-tr)*b;
      d[i++] = tg + (255-tg)*b;
      d[i++] = tb + (255-tb)*b;
      d[i++] = 255*clamp(dens*1.02 + hot*0.60, 0, 1);
    }
  }
  g.putImageData(img,0,0);
}

function paintCloud(idx, t, res){
  var c=CLOUD[idx];
  if(!c.cv) return;
  var ph=TAU*t/CYCLE;
  var dw=W*c.over, dh=H*c.over;
  var ox=(W-dw)*0.5 - syC*W*c.par + Math.sin(ph + idx*1.7)*W*c.drift;
  var oy=(H-dh)*0.5 + spC*H*c.par*1.4 + Math.cos(ph*0.7 + idx)*H*c.drift;
  ctx.globalCompositeOperation = LIGHT ? 'multiply' : 'lighter';
  ctx.globalAlpha = c.a * (0.70 + 0.26*res) * (0.86 + 0.14*Math.sin(ph*2 + idx*2.3));
  ctx.drawImage(c.cv, ox, oy, dw, dh);
  ctx.globalAlpha = 1;
}

/* --------------------------------------------------------- the deep field */
var stars=[], SR=rng(4242);
for(var i2=0;i2<520;i2++){
  var u1=SR()*2-1, th=SR()*TAU, rr2=Math.sqrt(1-u1*u1), rad=26+SR()*22;
  stars.push({ p:[rr2*Math.cos(th)*rad, u1*rad, rr2*Math.sin(th)*rad],
               m:0.25+SR()*0.75, tw:SR()*TAU, big:SR()>0.955 });
}
var dust=[], DR=rng(1337);
for(var i3=0;i3<300;i3++){
  var u2=DR()*2-1, th2=DR()*TAU, rr3=Math.sqrt(1-u2*u2), rad2=3.6+Math.pow(DR(),0.6)*10;
  dust.push({ p:[rr3*Math.cos(th2)*rad2, u2*rad2*0.7, rr3*Math.sin(th2)*rad2],
              m:0.2+DR()*0.8, ph:DR()*TAU });
}

function drawField(t, res){
  if(AVATAR){                      /* nothing behind the glyph but the desktop */
    ctx.globalCompositeOperation='source-over';
    ctx.clearRect(0,0,W,H);
    if(ADE.backing){
      var rad = PX*1.24;
      var bk = ctx.createRadialGradient(CX,CY,0, CX,CY,rad);
      var k  = (LIGHT ? 0.62 : 0.30) + 0.22*res;
      var G = LIGHT ? '203,209,217' : '4,8,20';
      bk.addColorStop(0,    'rgba('+G+','+(k).toFixed(3)+')');
      bk.addColorStop(0.26, 'rgba('+G+','+(k*0.80).toFixed(3)+')');
      bk.addColorStop(0.56, 'rgba('+G+','+(k*0.34).toFixed(3)+')');
      bk.addColorStop(0.80, 'rgba('+G+','+(k*0.09).toFixed(3)+')');
      bk.addColorStop(1,    'rgba('+G+',0)');
      ctx.fillStyle=bk;
      ctx.beginPath(); ctx.arc(CX,CY,rad,0,TAU); ctx.fill();
    }
    ctx.globalCompositeOperation=BLEND;
    return;
  }
  /* the ground: a shallow diagonal lift, never a centred pool with dark corners */
  var bg = ctx.createLinearGradient(0, 0, W*0.75, H);
  bg.addColorStop(0,    GROUND[0]);
  bg.addColorStop(0.45, GROUND[1]);
  bg.addColorStop(1,    GROUND[2]);
  ctx.globalCompositeOperation='source-over';
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

  paintCloud(0, t, res);          /* the far veil, behind the stars */

  ctx.globalCompositeOperation=BLEND;
  for(var j=0;j<stars.length;j++){
    var st=stars[j], sp=P(st.p, 0, true);
    if(sp.z<1) continue;
    var tw = 0.62+0.38*Math.sin(t*1.7+st.tw);
    var a = st.m*tw*(LIGHT ? 0.30 : 0.85)*(0.55+0.45*res);
    var r = (0.5+st.m*1.3)*S;
    if(LIGHT){                       /* on pale stock these are dust motes, not stars */
      ctx.globalAlpha=a; ctx.fillStyle=rgba(st.big?BLUE:STEEL, 1);
      ctx.fillRect(sp.x-r*0.4, sp.y-r*0.4, r*0.8, r*0.8);
    } else {
      dot(SP_WHITE, sp.x, sp.y, r*2.4, a*0.5);
      ctx.globalAlpha=a; ctx.fillStyle='#dfe9ff';
      ctx.fillRect(sp.x-r*0.35, sp.y-r*0.35, r*0.7, r*0.7);
      if(st.big){
        ctx.globalAlpha=a*0.5; ctx.fillStyle=rgba(BLUEH,1);
        ctx.fillRect(sp.x-r*3.2, sp.y-0.5, r*6.4, 1);
        ctx.fillRect(sp.x-0.5, sp.y-r*3.2, 1, r*6.4);
      }
    }
  }
  ctx.globalAlpha=1;

  paintCloud(1, t, res);          /* and two nearer veils drift across them */
  paintCloud(2, t, res);
  ctx.globalCompositeOperation=BLEND;
  ctx.globalAlpha=1;
}

function drawDust(t, res, asm){
  if(AVATAR) return;      /* free-floating dust reads as screen dirt on a desktop */
  ctx.globalCompositeOperation=BLEND;
  var drift = TAU*t/CYCLE;
  for(var i=0;i<dust.length;i++){
    var d=dust[i], sp=P(d.p, drift*0.5, true);
    if(sp.z<0.6) continue;
    var pl = 0.45+0.55*Math.sin(t*0.9+d.ph);
    var r = (0.8+d.m*1.9)*sp.s/PX*S*3.2;
    var a = d.m*0.30*pl*(0.35+0.65*res)*(0.4+0.6*asm)*sp.d;
    dot(i%3===0?SP_GOLD:SP_BLUE, sp.x, sp.y, r*2.2, a);
  }
  ctx.globalAlpha=1;
}

/* ------------------------------------------------ volumetric core lighting */
function drawVolumetrics(t, res, asm){
  var c = P([0,0,0],0,false);
  ctx.globalCompositeOperation=BLEND;
  var hv = LIGHT ? 0.40 : 1;       /* on light stock this warms, it must not whiten */
  var halo = 300*S*(0.55+0.9*res)*(0.3+0.7*asm)*(focal/900)*(LIGHT?0.82:1);
  var hg = ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,halo);
  var h0 = MOOD.mood ? MOOD.halo : (LIGHT ? GOLD : GOLDH);
  var h1 = MOOD.mood ? mix(MOOD.halo, BLUEH, 0.45) : (LIGHT ? BLUEH : GOLD);
  var h2 = MOOD.mood ? mix(MOOD.halo, BLUE, 0.6) : BLUE;
  hg.addColorStop(0,    rgba(h0, (0.20*res+0.05)*hv));
  hg.addColorStop(0.16, rgba(h1, (0.11*res+0.03)*hv));
  hg.addColorStop(0.44, rgba(h2, (0.055*res+0.015)*hv));
  hg.addColorStop(1,    rgba(BLUE, 0));
  ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(c.x,c.y,halo,0,TAU); ctx.fill();

  /* god-rays: shafts of light leaving the core */
  var n = 26, u = flow(t);
  ctx.save(); ctx.translate(c.x,c.y);
  for(var i=0;i<n;i++){
    var a = i/n*TAU + u*TAU*0.35 + Math.sin(i*2.3)*0.1;
    var len = halo*(0.55+0.45*Math.abs(Math.sin(i*1.7 + u*TAU*2)))*(0.5+0.5*res);
    var wdt = (2.2+2.6*Math.sin(i*3.1))*S;
    var lg = ctx.createLinearGradient(0,0,Math.cos(a)*len,Math.sin(a)*len);
    var cl = MOOD.mood ? MOOD.halo : (i % 3 === 0 ? (LIGHT ? GOLD : GOLDH) : BLUEH);
    lg.addColorStop(0, rgba(cl, 0.115*res*asm*hv));
    lg.addColorStop(1, rgba(cl, 0));
    ctx.fillStyle=lg;
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.lineTo(Math.cos(a)*len - Math.sin(a)*wdt, Math.sin(a)*len + Math.cos(a)*wdt);
    ctx.lineTo(Math.cos(a)*len + Math.sin(a)*wdt, Math.sin(a)*len - Math.cos(a)*wdt);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha=1;
}

/* ---------------------------------------------------- the sequential stages */
var CHAINS = 6;                                  /* whole stage-chains per cycle */
function stageGlow(u, k){
  var f = (5*CHAINS*u) % 5, d = f - k;
  if(d >  2.5) d -= 5;
  if(d < -2.5) d += 5;
  var sweep = Math.exp(-d*d*3.0);
  if(!AUDIO.on) return sweep;
  return clamp(Math.max(sweep*0.30, AUDIO.bands[k]), 0, 1);
}

/* --------------------------------------------------------- orbital rings */
function ringPoint(rr, a, sc){
  var x=Math.cos(a)*rr.r*sc, y=0, z=Math.sin(a)*rr.r*sc;
  var cx1=Math.cos(rr.tx), sx1=Math.sin(rr.tx);
  var y1=y*cx1 - z*sx1, z1=y*sx1 + z*cx1;
  var cz1=Math.cos(rr.tz), sz1=Math.sin(rr.tz);
  return [ x*cz1 - y1*sz1, x*sz1 + y1*cz1, z1 ];
}

function strokeBanded(pts, col, baseW, baseA, glow){
  var BANDS=9;
  for(var b=0;b<BANDS;b++){
    var t0=b/BANDS, t1=(b+1)/BANDS, any=false;
    ctx.beginPath();
    for(var i=0;i<pts.length-1;i++){
      var p0=pts[i], p1=pts[i+1];
      if(p0.z<0.5||p1.z<0.5) continue;
      var d=(p0.d+p1.d)*0.5;
      if(d>=t0 && d<t1){ ctx.moveTo(p0.x,p0.y); ctx.lineTo(p1.x,p1.y); any=true; }
    }
    if(!any) continue;
    var dm=(t0+t1)*0.5, dep=0.22+0.78*dm;
    if(glow){
      ctx.lineWidth=baseW*(2.5+5.0*dep)*S; ctx.strokeStyle=rgba(col, baseA*dep*0.12); ctx.stroke();
    }
    ctx.lineWidth=Math.max(1.5, baseW*(1.45+2.45*dep)*S);
    ctx.strokeStyle=rgba(col, baseA*dep); ctx.stroke();
  }
}

function drawRings(t, u, res, asm){
  ctx.globalCompositeOperation=BLEND;
  ctx.lineCap='round';
  var scale = lerp(1.85, 1, easeOut(asm));
  var spinGate = ss(2.6, 7, t) * 0.55 + 0.45;      /* rings spin up in the 3-7s window */
  for(var i=0;i<RINGS.length;i++){
    var rr=RINGS[i], gl=stageGlow(u,i);
    var spin = TAU*rr.turns*u*spinGate
      * (1 + (MOOD.mood ? MOODS[MOOD.mood].spiral : 0) * 0.12);
    if (MOOD.mode === 'ask-first' && !MOOD.mood) rr._calmA = 0.16; else rr._calmA = 0;
    var pts=rr.proj;
    for(var j=0;j<rr.angles.length;j++){
      pts[j] = P(ringPoint(rr, rr.angles[j]+spin, scale), 0, false, pts[j] || {});
    }
    var a = (0.32 + 0.50*res + 0.55*gl) * asm + (rr._calmA || 0);
    strokeBanded(pts, rr.col, 1.05+0.9*gl, a, true);
  }
  ctx.globalAlpha=1;
}

/* ------------------------------------------------ the Metatron structure */
var NP=[], NW=[];
function updateNodes(asm){
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i], p=n.p;
    if(asm<0.999){
      var e=clamp((asm - n.delay*0.4)/(1 - n.delay*0.4), 0, 1), kk=1-easeOut(e);
      p=[ n.p[0]*(1+1.7*kk) + n.sc[0]*kk*3.1,
          n.p[1]*(1+1.7*kk) + n.sc[1]*kk*3.1,
          n.p[2]*(1+1.7*kk) + n.sc[2]*kk*3.1 ];
    }
    NW[i]=p; NP[i]=P(p, 0, false, NP[i] || {});
  }
}

function drawStructure(t, u, res, asm){
  ctx.globalCompositeOperation=BLEND;
  ctx.lineCap='round';

  /* the thirteen circles, faint */
  var ca = (LIGHT ? 0.40 : 0.23)*asm*(0.45+0.55*res);
  if(ca>0.01){
    for(var c0=0;c0<circles.length;c0++){
      var src=circles[c0], pr=[];
      for(var s0=0;s0<src.length;s0++){
        var q=src[s0], nb=NW[c0], ob=nodes[c0].p;
        pr.push(P([q[0]+nb[0]-ob[0], q[1]+nb[1]-ob[1], q[2]+nb[2]-ob[2]], 0, false, tmp()));
      }
      strokeBanded(pr, mix(BLUE,STEEL,0.4), 0.75, ca, false);
    }
  }

  /* the 60 edges */
  for(var i=0;i<edges.length;i++){
    var ed=edges[i], A=NP[ed.a], B=NP[ed.b];
    if(A.z<0.5||B.z<0.5) continue;
    var d=(A.d+B.d)*0.5, dep=0.20+0.80*d;
    var flowPulse = 0.5+0.5*Math.sin(TAU*(u*18) - (ed.a+ed.b)*0.55);
    var a = ed.w * asm * (0.30 + 0.60*res) * dep * (0.72 + 0.5*flowPulse*res);
    var col = mix(ed.c, LIGHT ? BLUEH : GOLDH, res*0.35);
    /* The structure ITSELF carries the microphone -- one mechanism at three
       strengths, because the sixty edges are the figure's visible mass and
       anything smaller cannot be seen. Per-node marks were tried first and
       measured at 3 cool pixels for the whole frame: the nodes project to about
       1.6px here, so a mark on one is not a cue, whatever its colour.

         open mic   a calm 22% cool -- present, not shouting
         your voice a strong shift, so being heard is unmistakable, and so it
                    stays distinguishable from Ade talking back (both raise the
                    resonance; brightness alone reads the same either way)
         wake word  a flash through every edge at once */
    if(AVATAR){
      var lisE = clamp(0.22*ADE.micLit + 0.70*ADE.hearing + 0.85*wakeKick(), 0, 1);
      if(lisE > 0.01) col = mix(col, LISTEN, lisE);
    }
    ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y);
    ctx.lineWidth=(2.0+6.8*ed.w*res)*dep*S; ctx.strokeStyle=rgba(col, a*0.16); ctx.stroke();
    ctx.lineWidth=Math.max(1.7,(1.40+2.70*ed.w)*dep*S); ctx.strokeStyle=rgba(col, a); ctx.stroke();
    if(res>0.7 && ed.w>0.85){
      ctx.lineWidth=Math.max(1.1,0.95*dep*S);
      ctx.strokeStyle=rgba(GOLDH, a*(res-0.7)*2.4); ctx.stroke();
    }
  }

  /* nested solids: octahedron, cube, and the merkaba that ignites at resonance */
  drawSolid(OCT_V, OCT_E, 1, -u*TAU, mix(BLUE,CYAN,0.5), 0.44*asm*(0.3+0.7*res));
  drawSolid(CUB_V, CUB_E, 1,  u*TAU*0.5, mix(GOLD,GOLDH,0.3), 0.34*asm*(0.3+0.7*res));
  var mk = ss(0.68,0.94,res)*asm;
  if(mk>0.01){
    drawSolid(TET_A, TET_E, 1, u*TAU*1.5, GOLDH, 0.46*mk);
    drawSolid(TET_B, TET_E, 1, u*TAU*1.5, BLUEH, 0.46*mk);
  }
}

function drawSolid(V, E2, sc, spin, col, alpha){
  if(alpha<=0.008) return;
  var pv=[];
  for(var i=0;i<V.length;i++) pv.push(P([V[i][0]*sc,V[i][1]*sc,V[i][2]*sc], spin, false, tmp()));
  for(var e=0;e<E2.length;e++){
    var A=pv[E2[e][0]], B=pv[E2[e][1]];
    if(A.z<0.5||B.z<0.5) continue;
    var dep=0.18+0.82*((A.d+B.d)*0.5);
    ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y);
    ctx.lineWidth=5.4*dep*S; ctx.strokeStyle=rgba(col, alpha*dep*0.14); ctx.stroke();
    ctx.lineWidth=Math.max(1.5,2.20*dep*S); ctx.strokeStyle=rgba(col, alpha*dep); ctx.stroke();
  }
}

/* ------------------------------------------------------------ the nodes */
function drawNodes(t, u, res, asm){
  ctx.globalCompositeOperation=BLEND;
  for(var i=1;i<nodes.length;i++){
    var n=nodes[i], sp=NP[i];
    if(sp.z<0.5) continue;
    var outer = n.kind==='outer';
    var gl = outer ? stageGlow(u, n.k%5) : 0;
    var beat = 0.5+0.5*Math.sin(TAU*(u*22) - (outer?n.k*0.9:n.k*0.5+2.0));
    var col = outer ? GOLD : mix(BLUE,GOLDH,0.25);
    var hot = mix(col, LIGHT ? BLUEH : WHITE, 0.55*res);
    /* the open microphone lives HERE, on the thirteen nodes, rather than in a
       ring drawn around the piece: a listening machine that looks identical to a
       deaf one is the thing people are right to dislike, and the glyph itself is
       what they are looking at. */
    var wk = AVATAR ? wakeKick() : 0;
    var lis = AVATAR ? clamp(0.85*ADE.micLit + 0.85*ADE.hearing + 1.0*wk, 0, 1) : 0;
    if(lis > 0.004){
      hot = mix(hot, LISTENH, clamp(lis*0.95, 0, 1));
      col = mix(col, LISTEN,  clamp(lis*0.75, 0, 1));
    }
    var base = (outer?7.0:5.0)*S*(sp.s/PX)*(0.62+0.38*res)*(0.55+0.45*beat);
    var a = asm*(0.30+0.70*res)*(0.35+0.65*sp.d)*(1 + 0.85*wk);
    dot(SP_BLUE, sp.x, sp.y, base*5.4, a*0.16*(outer?0.7:1));
    /* and the microphone reads on the nodes themselves. A hue shift on the
       facet hairline was too little to see -- measured at 0.06x the frame's own
       variance -- so each node carries its own cool glow while the track is
       open. Thirteen marks on the figure, not one ring around it. */
    dot(outer?SP_GOLD:SP_BLUE, sp.x, sp.y, base*2.7, a*0.42*(1+gl));
    dot(SP_WHITE, sp.x, sp.y, base*0.95, a*(0.62+0.38*gl));
    /* AFTER the gold and the white core, not before: drawn first, the node's own
       marks paint straight over the middle of it and only the faint outer edge
       survives -- measured at 12 cool pixels for the whole figure, which is not a
       cue, it is a rounding error. */
    /* The node's visible mass is these fixed-colour sprites, not `col` and `hot`
       -- those only reach a hairline facet, which is why tinting them measured
       nothing at all. So the microphone is drawn as its own mark, at the same
       size and weight as the gold one it sits on, and the node itself turns. */
    if(lis > 0.004){
      if(!SP_LISTEN) SP_LISTEN = sprite(LISTEN);
      dot(SP_LISTEN, sp.x, sp.y, base*5.4*(1+0.35*wk), a*0.34*lis);
      dot(SP_LISTEN, sp.x, sp.y, base*2.7*(1+0.45*wk), a*0.62*lis*(1+gl));
    }

    /* crystalline facet — a small faceted shell that catches the core light */
    var rr5=base*1.55, rot=u*TAU*(outer?1:-1.5)+n.k;
    ctx.beginPath();
    for(var f=0;f<6;f++){
      var ang=rot+f/6*TAU, px=sp.x+Math.cos(ang)*rr5, py=sp.y+Math.sin(ang)*rr5*0.92;
      if(f===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.closePath();
    ctx.lineWidth=Math.max(1.5,2.4*S); ctx.strokeStyle=rgba(hot, a*0.62*(0.4+0.6*gl)); ctx.stroke();
    ctx.fillStyle=rgba(col, a*0.06); ctx.fill();
    /* specular glint */
    dot(SP_WHITE, sp.x-rr5*0.34, sp.y-rr5*0.40, base*0.42, a*0.55);
  }
  ctx.globalAlpha=1;
}

/* -------------------------------------------------------- energy particles */
var TRIPS = 14, PR2 = rng(24680), spokeJit=[];
for(var i4=0;i4<6;i4++){ spokeJit.push([PR2()*TAU, PR2()*TAU, PR2()*TAU]); }

function drawParticles(t, u, res, asm){
  ctx.globalCompositeOperation=BLEND;
  var scale = lerp(1.85, 1, easeOut(asm));
  var spinGate = ss(2.6, 7, t)*0.55 + 0.45;

  /* along the orbital rings */
  for(var i=0;i<RINGS.length;i++){
    var rr=RINGS[i], gl=stageGlow(u,i);
    var cnt = 7 + Math.round(res*20);
    var spin = TAU*rr.turns*u*spinGate;
    var pturns = 9 + i*2, dir = rr.turns<0 ? -1 : 1;
    for(var j=0;j<cnt;j++){
      var ph = (u*pturns + j/cnt)%1;
      var ang = ph*TAU + spin;
      var sp = P(ringPoint(rr, ang, scale), 0, false, tmp());
      if(sp.z<0.5) continue;
      var r = (1.5+2.4*res)*S*(sp.s/PX)*(0.55+0.45*sp.d);
      var a = asm*(0.25+0.75*res)*(0.30+0.70*sp.d)*(0.45+0.85*gl);
      dot(SP_BLUE, sp.x, sp.y, r*4.2, a*0.24);
      dot(SP_WHITE, sp.x, sp.y, r*1.15, a*0.85);
      var sp2 = P(ringPoint(rr, ang - dir*0.045, scale), 0, false, tmp());
      ctx.globalAlpha=a*0.35; ctx.strokeStyle=rgba(mix(rr.col,WHITE,0.4),1);
      ctx.lineWidth=Math.max(1.0, r*0.95);
      ctx.beginPath(); ctx.moveTo(sp2.x,sp2.y); ctx.lineTo(sp.x,sp.y); ctx.stroke();
    }
  }
  ctx.globalAlpha=1;

  /* down the six spokes: outer node to the core */
  var core = NW[0];
  for(var k=0;k<6;k++){
    var on = NW[OUT(k)];
    var per = 3 + Math.round(res*6);
    for(var m=0;m<per;m++){
      var ph2 = (u*TRIPS + m/per + k*0.07)%1;
      var s3 = 1-ph2;
      var acc = s3*s3*(3-2*s3);
      var wob = Math.sin(ph2*TAU*3 + spokeJit[k][0])*0.075*acc;
      var sp3 = P([lerp(core[0],on[0],acc)+wob*0.6, lerp(core[1],on[1],acc)+wob, lerp(core[2],on[2],acc)+wob*0.8], 0, false, tmp());
      if(sp3.z<0.5) continue;
      var r2 = (2.0+2.8*res)*S*(sp3.s/PX)*(1.05-0.45*acc);
      var a2 = asm*(0.35+0.65*res)*(0.30+0.70*sp3.d)*(0.35+0.65*(1-acc));
      dot(SP_GOLD, sp3.x, sp3.y, r2*4.6, a2*0.26);
      dot(SP_WHITE, sp3.x, sp3.y, r2*1.1, a2);
      var b2 = Math.min(1, acc+0.055);
      var sp4 = P([lerp(core[0],on[0],b2), lerp(core[1],on[1],b2), lerp(core[2],on[2],b2)],0,false,tmp());
      var lg2 = ctx.createLinearGradient(sp4.x,sp4.y,sp3.x,sp3.y);
      lg2.addColorStop(0, rgba(GOLD,0)); lg2.addColorStop(1, rgba(GOLDH,a2*0.7));
      ctx.strokeStyle=lg2; ctx.lineWidth=Math.max(1.1, r2*1.00);
      ctx.beginPath(); ctx.moveTo(sp4.x,sp4.y); ctx.lineTo(sp3.x,sp3.y); ctx.stroke();
    }
  }
  ctx.globalAlpha=1;

  /* the condensation cloud that forms and releases the glyph */
  var form = 1-asm;
  if(form>0.01){
    for(var d2=0;d2<230;d2++){
      var seed=d2*0.618034, ang2=(seed*TAU)%TAU, elev=((seed*7.13)%1)*2-1;
      var rr6=Math.sqrt(1-elev*elev), rad3=lerp(0.4, 9.0, (seed*3.77)%1)*(0.35+0.9*form);
      var sp5=P([rr6*Math.cos(ang2+u*TAU*2)*rad3, elev*rad3, rr6*Math.sin(ang2+u*TAU*2)*rad3],0,false,tmp());
      if(sp5.z<0.5) continue;
      var a3 = form*0.95*(0.3+0.7*sp5.d)*(0.55+0.45*Math.sin(seed*11+t*3));
      dot(d2%2?SP_GOLD:SP_BLUE, sp5.x, sp5.y, (2.4+2*form)*S*(sp5.s/PX)*2.6, a3*0.8);
    }
  }
  ctx.globalAlpha=1;
}

/* ------------------------------------------------ electromagnetic arcing */
var arcs=[], AR=rng(31337);
for(var at=0; at<CYCLE; at+=0.085){
  if(AR() < 0.06 + 0.62*resonance(at)){
    var na = 1+((AR()*12)|0), nb = 1+((AR()*12)|0);
    if(na===nb) nb = 1 + (nb%12);
    arcs.push({ t0:at, dur:0.16+AR()*0.30, a:na, b:nb, seed:(AR()*100000)|0, hue:AR() });
  }
}
function paintArc(ar, age, env, res, asm){
  var A=NP[ar.a], B=NP[ar.b];
  if(!A||!B||A.z<0.5||B.z<0.5) return;
  var dx=B.x-A.x, dy=B.y-A.y, len=Math.sqrt(dx*dx+dy*dy);
  if(len<1) return;
  var nx3=-dy/len, ny3=dx/len;
  var rr7=rng(ar.seed + ((age*36)|0));
  var col = ar.hue>0.55 ? GOLDH : BLUEH;
  var amp = len*0.10*(0.4+0.6*res);
  ctx.beginPath(); ctx.moveTo(A.x,A.y);
  for(var s5=1;s5<12;s5++){
    var f2=s5/12, bend=Math.sin(f2*Math.PI)*amp*(rr7()*2-1);
    ctx.lineTo(A.x+dx*f2+nx3*bend, A.y+dy*f2+ny3*bend);
  }
  ctx.lineTo(B.x,B.y);
  ctx.lineWidth=6.6*S*env; ctx.strokeStyle=rgba(col, 0.09*env*res*asm); ctx.stroke();
  ctx.lineWidth=Math.max(1.3,2.30*S*env); ctx.strokeStyle=rgba(col, 0.70*env*asm); ctx.stroke();
  ctx.lineWidth=Math.max(0.9,0.95*S*env); ctx.strokeStyle=rgba(WHITE, 0.52*env*asm); ctx.stroke();
}

/* transients in the voice throw their own arcs, outside the scheduled ones */
var liveArcs=[], liveWaves=[], LR=rng(90909);
function spawnOnset(nowS){
  var n = 1 + ((LR()*3)|0);
  for(var i=0;i<n;i++){
    var a=1+((LR()*12)|0), b=1+((LR()*12)|0);
    if(a===b) b = 1 + (b%12);
    liveArcs.push({ born:nowS, dur:0.16+LR()*0.26, a:a, b:b, seed:(LR()*100000)|0, hue:LR() });
  }
  liveWaves.push({ born:nowS });
  if(liveArcs.length>28) liveArcs.splice(0, liveArcs.length-28);
  if(liveWaves.length>6)  liveWaves.splice(0, liveWaves.length-6);
}

function drawArcs(t, res, asm){
  if(asm<0.2) return;
  ctx.globalCompositeOperation=BLEND; ctx.lineCap='round';
  for(var i=0;i<arcs.length;i++){
    var ar=arcs[i], lt=t-ar.t0;
    if(lt<0) lt+=CYCLE;
    if(lt>ar.dur) continue;
    paintArc(ar, lt, Math.sin(Math.PI*(lt/ar.dur)), res, asm);
  }
  for(var q=0;q<liveArcs.length;q++){
    var la=liveArcs[q], age=NOWS-la.born;
    if(age<0 || age>la.dur) continue;
    paintArc(la, age, Math.sin(Math.PI*(age/la.dur)), res, asm);
  }
  ctx.globalAlpha=1;
}

/* --------------------------------------------------------- the core field */
function paintWave(rad, alpha){
  if(alpha<0.01) return;
  for(var pl=0;pl<3;pl++){
    var pts3=WAVEBUF[pl];
    for(var s6=0;s6<=56;s6++){
      var ag=s6/56*TAU, ux=Math.cos(ag)*rad, uy=Math.sin(ag)*rad, wp2;
      if(pl===0) wp2=[ux,uy,0]; else if(pl===1) wp2=[ux,0,uy]; else wp2=[0,ux,uy];
      pts3[s6]=P(wp2,0,false,pts3[s6]||{});
    }
    strokeBanded(pts3, mix(GOLDH,BLUEH,pl/2), 1.3, alpha*0.9, true);
  }
}
var WAVES = 18, WAVEBUF=[[],[],[]];
function drawCore(t, u, res, asm){
  var c = P(NW[0] || [0,0,0], 0, false, tmp());
  ctx.globalCompositeOperation=BLEND;
  /* the multiplier is exactly 1 with the microphone off, so the 24s loop
     still closes on itself; only a live voice detunes the beat */
  var pmul = AUDIO.on ? (0.70 + 0.90*AUDIO.tone) : 1;
  var pulse = 0.5+0.5*Math.sin(TAU*(u*54*pmul));
  var warmth = AUDIO.on ? ss(0.35, 0.95, AUDIO.tone) : 0;
  var HOT = MOOD.mood ? MOOD.hot : (warmth > 0 ? mix(GOLDH, BLUEH, warmth) : GOLDH);
  var MID = MOOD.mood ? MOOD.mid : (warmth > 0 ? mix(GOLD, CYAN, warmth) : GOLD);
  if(AVATAR){
    if(!ADE.online){ HOT = mix(HOT, STEEL, 0.78); MID = mix(MID, STEEL, 0.78); }
    /* the core itself cools while your voice is arriving -- a ring at the edge is
       an ornament, but the core is the thing the eye is already on. Applied
       BEFORE alert on purpose: an approval waiting on a human outranks being
       heard, and must not be tinted away by someone talking over it. */
    if(ADE.hearing > 0.01){
      HOT = mix(HOT, LISTENH, ADE.hearing*0.42); MID = mix(MID, LISTEN, ADE.hearing*0.52);
    }
    if(ADE.alert > 0.01){ HOT = mix(HOT, ALERT, ADE.alert*0.85); MID = mix(MID, ALERT, ADE.alert*0.85); }
  }
  var breatheAmp = MOOD.mood ? MOODS[MOOD.mood].breathe : 0.20;
  var devTick = MOOD.mode === 'dev' ? 0.9 + 0.1 * Math.sin(NOWS * 6) : 1;
  var flickK = MOOD.flick ? 0.85 + 0.15 * Math.sin(NOWS * 20) : 1;
  var breathe = flickK * (1 + breatheAmp * pulse * (0.35 + 0.85 * res) * devTick);
  var base = 14.5*S*(focal/900)*(0.55+0.75*res)*breathe*(0.25+0.75*asm)*(1+0.34*AUDIO.flash+0.30*wakeKick()+0.55*MOOD.burst+0.40*MOOD.ember);

  /* concentric energy waves: three orthogonal fronts read as a sphere */
  if(res>0.45){
    var wAmp = ss(0.45,0.9,res)*asm;
    for(var wv=0; wv<3; wv++){
      var wph = ((u*WAVES) - wv/3)%1;
      if(wph<0) wph+=1;
      var wa = (1-wph)*(1-wph)*wAmp*0.85;
      if(wa>=0.01) paintWave(wph*3.3, wa);
    }
  }
  /* and one front per vocal transient */
  for(var lw=0; lw<liveWaves.length; lw++){
    var ag2=(NOWS-liveWaves[lw].born)/0.78;
    if(ag2<0 || ag2>1) continue;
    paintWave(ag2*3.5, (1-ag2)*(1-ag2)*0.95*asm);
  }

  var g0=ctx.createRadialGradient(c.x,c.y,0,c.x,c.y,base*7.5);
  g0.addColorStop(0,    rgba(WHITE, 0.92*asm));
  g0.addColorStop(0.040,rgba(HOT,  0.90*asm));
  g0.addColorStop(0.115,rgba(MID,  0.70*asm));
  g0.addColorStop(0.230,rgba(MID,  0.32*asm));
  g0.addColorStop(0.400,rgba(mix(MID,BLUE,0.55), 0.15*asm*(0.4+0.6*res)));
  g0.addColorStop(0.680,rgba(BLUE,  0.060*asm*(0.4+0.6*res)));
  g0.addColorStop(1,    rgba(BLUE, 0));
  ctx.fillStyle=g0; ctx.beginPath(); ctx.arc(c.x,c.y,base*7.5,0,TAU); ctx.fill();
  dot(SP_WHITE, c.x, c.y, base*1.5, 0.95*asm);

  var stW = base*9.5*(0.30+0.72*res), stH=Math.max(1.1, base*0.14);
  var lg3=ctx.createLinearGradient(c.x-stW,c.y,c.x+stW,c.y);
  lg3.addColorStop(0,rgba(BLUEH,0)); lg3.addColorStop(0.42,rgba(BLUEH,(LIGHT?0.26:0.16)*res*asm));
  lg3.addColorStop(0.5,rgba(LIGHT?GOLDH:WHITE,(LIGHT?0.30:0.28)*res*asm)); lg3.addColorStop(0.58,rgba(BLUEH,(LIGHT?0.26:0.16)*res*asm));
  lg3.addColorStop(1,rgba(BLUEH,0));
  ctx.fillStyle=lg3; ctx.fillRect(c.x-stW, c.y-stH, stW*2, stH*2);

  var sn=8;
  for(var i=0;i<sn;i++){
    var ag2=i/sn*TAU + u*TAU*0.5;
    var ln=base*(2.6+3.4*pulse)*(0.4+0.9*res);
    var lg4=ctx.createLinearGradient(c.x,c.y,c.x+Math.cos(ag2)*ln,c.y+Math.sin(ag2)*ln);
    lg4.addColorStop(0,rgba(HOT,0.52*asm*res)); lg4.addColorStop(1,rgba(HOT,0));
    ctx.strokeStyle=lg4; ctx.lineWidth=Math.max(1.1, base*0.24);
    ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(c.x+Math.cos(ag2)*ln, c.y+Math.sin(ag2)*ln); ctx.stroke();
  }
  ctx.globalAlpha=1;
  return c;
}

/* ------------------------------------------------------ the listening mark */
/* An open microphone that looks exactly like a closed one is the thing the
   comment on MIC_OPEN already called out, and it stayed that way because
   setMic() was wired to nothing. This is what reads it.

   Everything here draws in LISTEN and everything here draws INWARD: sound is
   arriving. Ade's own voice is the warm core radiating outward. That opposition
   -- cool/inward against warm/outward -- is what makes "it can hear me" legible
   at a glance instead of inferred from timing. */
var wakeAt = -99;
/* "Ade" was heard. This runs through the STRUCTURE -- the same arc path a
   consonant takes when the piece is listening to music -- rather than drawing a
   ring around it. wakeKick() is read by the core and by the nodes. */
function wake(){
  wakeAt = NOWS;
  for(var wi=0; wi<3; wi++) spawnOnset(NOWS);
}
function wakeKick(){
  var k = 1 - (NOWS - wakeAt)/0.45;
  return k > 0 ? k*k : 0;
}

/* ------------------------------------------------------------ lens bloom */
function bloom(strength){
  var bw=q1.width, bh=q1.height;
  g1.globalCompositeOperation='source-over';
  g1.clearRect(0,0,bw,bh);
  g1.drawImage(cvs, 0,0, bw,bh);
  g2.globalCompositeOperation='source-over';
  g2.clearRect(0,0,bw,bh);
  g2.drawImage(q1,0,0);
  if(!AVATAR){                     /* ~A^3 rejects a dim background; transparency has none,
                                      and multiplying there only muddies the alpha */
    g2.globalCompositeOperation='multiply';
    g2.drawImage(q1,0,0); g2.drawImage(q1,0,0);
    g2.globalCompositeOperation='source-over';
  }
  for(var i=0;i<3;i++){
    gh.clearRect(0,0,h1.width,h1.height);
    gh.drawImage(q2, 0,0, h1.width,h1.height);
    g2.clearRect(0,0,bw,bh);
    g2.drawImage(h1, 0,0, bw,bh);
  }
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalCompositeOperation=BLEND;
  ctx.globalAlpha=strength;
  ctx.drawImage(q2, 0,0, cvs.width, cvs.height);
  ctx.restore();
  ctx.globalAlpha=1;
  ctx.globalCompositeOperation='source-over';
}

/* ------------------------------------------------------- grade & vignette */
var grain=(function(){
  var c=document.createElement('canvas'); c.width=c.height=128;
  var g=c.getContext('2d'), d=g.createImageData(128,128), r=rng(5150);
  for(var i=0;i<d.data.length;i+=4){
    var v=200+r()*55|0;
    d.data[i]=d.data[i+1]=d.data[i+2]=v; d.data[i+3]=255;
  }
  g.putImageData(d,0,0); return c;
})();
var grainPat=null;

function grade(res){
  ctx.globalCompositeOperation='source-over';
  if(AVATAR) return;               /* grain over transparency is a film on the desktop */
  if(grainPat){
    ctx.globalCompositeOperation = LIGHT ? 'multiply' : 'overlay';
    ctx.globalAlpha = LIGHT ? 0.050 : (0.030+0.014*res);
    ctx.fillStyle=grainPat; ctx.fillRect(0,0,W,H);
    ctx.globalAlpha=1;
  }
  ctx.globalCompositeOperation='source-over';
}

/* ------------------------------------------------------------------ loop */
function resize(){
  DPR = Math.min(window.devicePixelRatio||1, 2);
  if(AVATAR){                      /* the canvas owns its box; the window is taller */
    W = cvs.clientWidth  || window.innerWidth;
    H = cvs.clientHeight || Math.min(window.innerHeight, W);
  } else {
    W = stage.clientWidth  || window.innerWidth;
    H = stage.clientHeight || window.innerHeight;
  }
  cvs.width = Math.max(1, Math.round(W*DPR));
  cvs.height= Math.max(1, Math.round(H*DPR));
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.lineJoin='round';
  CX = W/2; CY = AVATAR ? H*0.50 : H*0.565;
  S  = clamp(Math.min(W/1280, H/820), 0.5, 1.5);
  PX = AVATAR ? Math.min(W,H)*0.44 : Math.min(W*0.42, H*0.345);
  var bw=Math.max(48, cvs.width>>2), bh=Math.max(36, cvs.height>>2);
  q1.width=bw; q1.height=bh; q2.width=bw; q2.height=bh;
  h1.width=Math.max(24,bw>>1); h1.height=Math.max(18,bh>>1);
  g1.imageSmoothingEnabled=g2.imageSmoothingEnabled=gh.imageSmoothingEnabled=true;
  grainPat = ctx.createPattern(grain,'repeat');
  requestCloud();
}

var epoch=0, NOWS=0, lastT=0;
function frame(now){
  NOWS = now/1000;
  var dt = clamp(NOWS - lastT, 0.001, 0.1); lastT = NOWS;
  var t = ((NOWS - epoch) % CYCLE + CYCLE) % CYCLE;
  var u, res, asm;

  u = flow(t); res = resonance(t); asm = assembly(t);
  if(AVATAR){
    pullMood();
    /* Ember drift: in auto mode a quiet orb self-sparks every 20-40s. It stays
       on its own glyph-local channel because pullMood() rewrites MOOD.burst from
       the mood frame every rAF -- an ember written there would vanish next frame.
       Gated on the mood core: without ADE_MOOD the orb renders exactly as legacy. */
    MOOD.ember -= dt;
    if (!MOOD.mood && MOOD.mode === 'auto' && window.ADE_MOOD && ADE.online && MOOD.ember <= 0) {
      MOOD.ember = 0.6; MOOD.ambient = 20 + Math.random() * 20;
    }
    ADE.step(dt);
    /* state leads; either voice overrides it. Yours lifts the orb less far than
       Ade's own does -- so the two stay distinguishable by ENERGY as well as by
       colour -- but it does lift it. It used to lift it not at all: Ade talking
       made the orb blaze while you talking left it sitting at idle, which is
       most of what "it doesn't react to me" was. */
    res = Math.max(res*0.35, ADE.res, ADE.speaking*0.92, ADE.hearing*0.72);
    res = Math.min(1, res + MOOD.burst * 0.15 + MOOD.ember * 0.1);
    if(ADE.alert > 0.55){
      ADE.spark -= dt;
      if(ADE.spark <= 0){ spawnOnset(NOWS); ADE.spark = 0.22 + 0.25*(1-ADE.alert); }
    }
  }
  if(AUDIO.on){
    AUDIO.sample(dt);
    /* The voice ADDS to the storyboard and never replaces it. A microphone that
       is granted and then not spoken into must still play the whole piece --
       driving the field from level alone blanked the screen in silence.
       AUDIO.phase only ever accumulates, and every phase built on u is an
       integer multiple of it, so the cycle seam stays invisible either way. */
    u  += AUDIO.phase;
    res = Math.max(res, AUDIO.res);
    if(AUDIO.onset) spawnOnset(NOWS);
  }

  buildCloudStep();
  POOLI = 0;
  setCamera(t, res);
  updateNodes(asm);

  drawField(t, res);
  drawDust(t, res, asm);
  drawVolumetrics(t, res, asm);
  drawRings(t, u, res, asm);
  drawStructure(t, u, res, asm);
  drawParticles(t, u, res, asm);
  drawArcs(t, res, asm);
  drawNodes(t, u, res, asm);
  drawCore(t, u, res, asm);
  if(!LIGHT) bloom(AVATAR ? 0.30 + 0.14*res : 0.44 + 0.20*res);
  grade(res);

  requestAnimationFrame(frame);
}

function start(){
  resize();
  epoch = lastT = performance.now()/1000;
  requestAnimationFrame(frame);
  if(!AVATAR) tryArm();
}
/* Whether the microphone is open. The avatar listens continuously now, and a
   listening machine that looks identical to a deaf one is the thing people
   are right to dislike -- so the glyph carries it. */
var MIC_OPEN = 0;
function setMic(v){ MIC_OPEN = v ? 1 : 0; }

window.GLYPH = {
  setMic: setMic,
  setAde: function(st){ ADE.apply(st||{}); },
  setBacking: function(on){ ADE.backing = !!on; },
  setSpeaking: function(v){ ADE.speak = clamp(+v || 0, 0, 1); },
  /* Ade's mouth is setSpeaking; YOUR voice is this. Two callers, two channels --
     they were one, and that is why the orb looked the same either way. */
  setHearing: function(v){ ADE.hear = clamp(+v || 0, 0, 1); },
  wake: wake,
  /* the live microphone's own analyser, so the piece's existing audio path
     drives the geometry: five bands -> five shells, loudness -> resonance,
     consonants -> arcs, pitch -> the core's colour */
  attachAudio: function(an, sr){ if(an) AUDIO.attach(an, sr); },
  detachAudio: function(){ AUDIO.detach(); },
  isHearingAudio: function(){ return !!(AUDIO.on && AUDIO.an); },
  /* the smoothed values the drawing actually reads, so a guard can tell a cue
     that is not drawn from an input that never arrived -- they look identical
     from the far side of a screenshot */
  _state: function(){ return { mic: MIC_OPEN, micLit: ADE.micLit,
    hearing: ADE.hearing, speaking: ADE.speaking, audio: !!(AUDIO.on && AUDIO.an),
    level: AUDIO.level || 0, env: AUDIO.env || 0,
    mood: MOOD.mood, mode: MOOD.mode, burst: +MOOD.burst.toFixed(3), tint: !!MOOD.tint }; },
  arm: function(){ tryArm(); },
  isArmed: function(){ return AUDIO.on; }
};
window.addEventListener('resize', resize, {passive:true});
window.addEventListener('pointerdown', tryArm, {passive:true});
window.addEventListener('keydown', tryArm);
start();
})();

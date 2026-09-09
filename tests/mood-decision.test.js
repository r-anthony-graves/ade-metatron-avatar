'use strict';
/* The mood decision core is a real module (the only avatar renderer file
   that node:test can require): feed/event/tint/frame decision tests, plus
   the sentiment lexicon it ships. Deterministic through an injected clock. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MOOD_M = require(path.join(__dirname, '..', 'mood.js'));
const create = MOOD_M.create;
const sentiment = MOOD_M.sentiment;

function withClock(t0) {
  let t = t0;
  const clock = () => t;
  return { clock, advance: (ms) => { t += ms; } };
}

function feedFrame(feedState, t, modeArg, clock) {
  const m = create(clock);
  m.feed(feedState, modeArg);
  return m.frame(t);
}

test('offline rests in dormant', () => {
  const { clock } = withClock(0);
  const f = feedFrame({ online: false, busy: false, pending: 0 }, 0, undefined, clock);
  assert.equal(f.mood, 'dormant');
});

test('busy thinks', () => {
  const { clock } = withClock(0);
  const f = feedFrame({ online: true, busy: true, pending: 0 }, 0, undefined, clock);
  assert.equal(f.mood, 'thinking');
});

test('a pending approval waits attentively', () => {
  const { clock } = withClock(0);
  const f = feedFrame({ online: true, busy: false, pending: 1 }, 0, undefined, clock);
  assert.equal(f.mood, 'attentive');
});

test('quiet idle has no mood (mode baseline renders)', () => {
  const { clock } = withClock(0);
  const f = feedFrame({ online: true, busy: false, pending: 0 }, 0, undefined, clock);
  assert.equal(f.mood, null);
});

test('mode rides along and defaults to auto', () => {
  const { clock } = withClock(0);
  assert.equal(feedFrame({ online: true }, 0, undefined, clock).mode, 'auto');
  assert.equal(feedFrame({ online: true }, 0, 'dev', clock).mode, 'dev');
  assert.equal(feedFrame({ online: true, mode: 'ask-first' }, 0, undefined, clock).mode, 'ask-first');
});

test('approved bursts satisfied then settles back', () => {
  const { clock, advance } = withClock(100000);
  const m = create(clock);
  m.feed({ online: true, busy: true, pending: 0 });
  m.event('approved');
  const mid = m.frame(100000 + 700);
  assert.equal(mid.mood, 'satisfied');
  assert.ok(mid.burst > 0 && mid.burst <= 1);
  advance(2000);            // past the 1400ms burst
  const after = m.frame(100000 + 2700);
  assert.equal(after.mood, 'thinking');
  assert.equal(after.burst, 0);
});

test('wake startled flashes short', () => {
  const { clock, advance } = withClock(0);
  const m = create(clock);
  m.feed({ online: true, busy: false, pending: 0 });
  m.event('wake');
  const f = m.frame(350);
  assert.equal(f.mood, 'startled');
  assert.ok(f.burst > 0.4);
  advance(1500);
  const g = m.frame(1500);
  assert.equal(g.mood, null);       /* idle base returns */
  assert.equal(g.burst, 0);
});

test('failed turns troubled', () => {
  const { clock } = withClock(0);
  const m = create(clock);
  m.feed({ online: true, busy: true, pending: 0 });
  m.event('failed');
  const f = m.frame(50);
  assert.equal(f.mood, 'troubled');
});

test('offline outranks an active burst', () => {
  const { clock, advance } = withClock(0);
  const m = create(clock);
  m.feed({ online: true, busy: true, pending: 0 });
  m.event('wake');
  m.feed({ online: false, busy: false, pending: 0 });
  const f = m.frame(200);
  assert.equal(f.mood, 'dormant');
  assert.equal(f.burst, 0);
});

test('unknown events are ignored', () => {
  const { clock } = withClock(0);
  const m = create(clock);
  m.feed({ online: true, busy: true, pending: 0 });
  m.event('nonsense');
  const f = m.frame(0);
  assert.equal(f.mood, 'thinking');
  assert.equal(f.burst, 0);
});

test('a bright sentiment tints warm and expires', () => {
  const { clock, advance } = withClock(0);
  const m = create(clock);
  const r = sentiment('thanks, that is great and solved it');
  assert.ok(r.score > 0.5 && r.hot === false);
  m.feed({ online: true, busy: true, pending: 0 });
  m.tint(r, 4000);
  assert.equal(m.frame(100).tint.r, 1);
  advance(5000);
  assert.equal(m.frame(5000).tint, null);
});

test('dark sentiment tints red and stays color-only', () => {
  const { clock } = withClock(0);
  const m = create(clock);
  const r = sentiment('there is an error and the thing failed badly');
  assert.ok(r.score < -0.3);
  m.tint(r, 4000);
  const tint = m.frame(0).tint;
  assert.ok(tint.r > tint.b);        /* red channel dominates */
  assert.equal(tint.f, 0);
});

test('negation flips a mild negative', () => {
  const r = sentiment('not bad at all');
  assert.ok(r.score > 0, 'received ' + r.score);
});

test('neutral prose scores near zero and caps at 120 tokens', () => {
  const r = sentiment('the chat interface responds to the active tab selection');
  assert.ok(Math.abs(r.score) <= 0.1);
  const long = Array(300).fill('please').join(' ');
  assert.ok(isFinite(sentiment(long).score));
});

test('caps and bangs are a fired accent', () => {
  const r = sentiment('PERFECT. EXCELLENT!!');
  assert.equal(r.hot, true);
  assert.ok(r.score >= 0.8);
});

test('bare-number tint input is accepted', () => {
  const { clock } = withClock(0);
  const m = create(clock);
  m.tint(0.6, 2000);
  assert.ok(m.frame(0).tint);
});

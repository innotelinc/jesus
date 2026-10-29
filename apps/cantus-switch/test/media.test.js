/**
 * Browser media pacing.
 *
 * A browser leg has no poll tick of its own, so the switch is responsible for
 * feeding it at exactly the rate it plays: one 20 ms frame per 20 ms of wall
 * clock. Two writers — the media path pushing the moment a carrier frame lands
 * and the ticker filling the gap — put more than 50 frames a second into a
 * socket that plays 50, and a measured tone came back at 780 Hz instead of
 * 1 kHz because the switch's own silence was interleaved with the carrier's
 * audio. These tests pin the single-writer contract and the clock behind it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Switch } from '../src/switch.js';

/** A switch with one call and two legs: a browser and a relay (carrier) leg. */
function twoLegs() {
  const sw = new Switch({
    domain: 'test.local',
    id: 'switch@test.local',
    secret: 'test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
  });
  const frames = [];
  const browser = {
    role: 'web',
    ws: { send: (buffer) => frames.push(buffer) },
    isAnswered: true,
    isEnded: false,
    received: 0,
    sent: 0,
    rx: null,
    rxAt: 0,
  };
  const carrier = { role: 'outbound', ws: null, isAnswered: true, isEnded: false, received: 0, sent: 0, rx: null, rxAt: 0 };
  const call = { id: 'call-1', state: 'answered', legs: [browser, carrier] };
  browser.call = call;
  carrier.call = call;
  sw.calls.set('call-1', call);
  sw.nextWebMediaAt = 0;
  return { sw, browser, carrier, frames };
}

/** Drive the ticker the way the timer does: one poll every 10 ms. */
function runClock(sw, { from = 1_000, to = 2_000, step = 10 } = {}) {
  sw.nextWebMediaAt = from;
  for (let at = from; at < to; at += step) sw.webMediaTick(at);
  return from;
}

test('the media path does not write to a browser socket on its own', () => {
  const { sw, carrier, frames } = twoLegs();
  sw.onMedia(carrier, Buffer.alloc(320, 0x11));
  assert.equal(frames.length, 0, 'only the ticker writes; a push here is the double-feed');
  assert.equal(carrier.rxAt > 0, true, 'the frame is buffered for the ticker');
});

test('a second of clock is exactly fifty frames, not fifty-five', () => {
  const { sw, frames } = twoLegs();
  runClock(sw, { from: 1_000, to: 2_000, step: 10 });
  assert.equal(frames.length, 50, `a browser playing 50 frames/s must be fed 50, got ${frames.length}`);
});

test('irregular carrier timing does not change the browser cadence', () => {
  const { sw, carrier, frames } = twoLegs();
  sw.nextWebMediaAt = 1_000;
  // 18 ms, 22 ms, a burst of two, then nothing: the carrier is not a clock.
  const arrivals = [1_000, 1_018, 1_040, 1_041, 1_080, 1_180, 1_181, 1_260];
  let pulled = 0;
  for (let at = 1_000; at < 2_000; at += 10) {
    while (pulled < arrivals.length && arrivals[pulled] <= at) {
      sw.onMedia(carrier, Buffer.alloc(320, 0x22));
      pulled += 1;
    }
    sw.webMediaTick(at);
  }
  assert.equal(frames.length, 50, 'the socket keeps its own clock, whatever the carrier does');
});

test('audio is never interleaved with the switch\'s own silence', () => {
  const { sw, carrier, frames } = twoLegs();
  const tone = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / 8000) * 8000), i * 2);

  // A carrier that delivers a frame every 20 ms, with the ticker polling on its
  // own 10 ms grid: some polls are due a frame and some are not.
  sw.nextWebMediaAt = 1_000;
  for (let at = 1_000; at < 2_000; at += 10) {
    if (at % 20 === 0) sw.onMedia(carrier, tone);
    sw.webMediaTick(at);
  }

  assert.equal(frames.length, 50);
  const silent = frames.filter((frame) => frame.every((byte) => byte === frame[0]));
  assert.equal(silent.length, 0, 'no tick may substitute silence for audio that is already there');

  // The frequency of what the browser received, over the whole second.
  const pcm = Buffer.concat(frames);
  let crossings = 0;
  for (let i = 2; i + 1 < pcm.length; i += 2) {
    if ((pcm.readInt16LE(i - 2) < 0) !== (pcm.readInt16LE(i) < 0)) crossings += 1;
  }
  const hz = crossings / 2 / (pcm.length / 2 / 8000);
  assert.ok(Math.abs(hz - 1000) < 25, `a 1 kHz tone must come back at 1 kHz, measured ${hz.toFixed(0)} Hz`);
});

test('a browser whose peer has gone quiet still gets a frame every tick', () => {
  const { sw, frames } = twoLegs();
  runClock(sw, { from: 1_000, to: 1_200, step: 10 });
  assert.equal(frames.length, 10, 'silence keeps the player alive; a starving leg is a dead call');
});

test('the caller is marked answered when a line picks up, and the line hears it', () => {
  const sw = new Switch({
    domain: 'test.local',
    id: 'switch@test.local',
    secret: 'test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
  });
  sw.endpoint.accept = () => true;

  const frames = [];
  const tone = (n) => {
    const frame = Buffer.alloc(320);
    for (let i = 0; i < 160; i += 1) frame.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * (n * 160 + i)) / 8000) * 8000), i * 2);
    return frame;
  };

  const inbound = {
    id: 'leg-in',
    role: 'inbound',
    endpoint: { accepted: false },
    state: 'new',
    isEnded: false,
    received: 0,
    sent: 0,
    rx: null,
    rxAt: 0,
    get isAnswered() {
      return this.state === 'answered';
    },
  };
  const web = {
    id: 'leg-web',
    role: 'web',
    ext: '101',
    ws: { send: (buffer) => frames.push(buffer) },
    state: 'ringing',
    isEnded: false,
    received: 0,
    sent: 0,
    rx: null,
    rxAt: 0,
    get isAnswered() {
      return this.state === 'answered';
    },
  };
  const call = {
    id: 'call-did',
    state: 'ringing',
    direction: 'inbound',
    from: 'voipms',
    to: '14132642700@test.local',
    events: [],
    legs: [inbound, web],
    pending: { settled: false, timer: setTimeout(() => {}, 0), candidates: [web] },
  };
  inbound.call = call;
  web.call = call;
  sw.calls.set(call.id, call);

  // The DID's route bridges without an explicit answer action, which is the
  // case that used to leave the caller leg `new` for the whole call.
  assert.equal(sw.answerLeg(call, web), true);
  assert.equal(inbound.state, 'answered', 'the caller leg is a participant once the line answers');

  sw.nextWebMediaAt = 1_000;
  for (let at = 1_000; at < 1_500; at += 10) {
    if (at % 20 === 0) sw.onMedia(inbound, tone((at - 1_000) / 20));
    sw.webMediaTick(at);
  }

  assert.equal(frames.length, 25, 'the line is fed at 50 frames a second');
  const silent = frames.filter((frame) => frame.every((byte) => byte === 0));
  assert.equal(silent.length, 0, 'and every one of those frames is the carrier, not silence');
});

test('a prompt played into a call is paced by the same clock', () => {
  const { sw, browser, frames } = twoLegs();
  const dir = mkdtempSync(join(tmpdir(), 'cantus-prompts-'));
  const wav = Buffer.alloc(44 + 960);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(960, 40);
  wav.fill(0x33, 44);
  writeFileSync(join(dir, 'hold.wav'), wav);
  sw.prompts = dir;

  assert.equal(sw.playTo(browser, 'hold'), true);
  assert.equal(frames.length, 0, 'playing a file does not write outside the ticker');
  runClock(sw, { from: 1_000, to: 1_060, step: 10 });
  assert.equal(frames.length, 3, 'three frames of prompt in three ticks');
  assert.equal(frames[0].equals(Buffer.alloc(320, 0x33)), true);
});

test('a stalled loop is not repaid as a burst', () => {
  const { sw, frames } = twoLegs();
  sw.nextWebMediaAt = 1_000;
  sw.webMediaTick(1_000);
  const afterFirst = frames.length;
  // The process blocked for 500 ms; the next poll must send one frame, not 25.
  sw.webMediaTick(1_500);
  assert.equal(frames.length - afterFirst, 1);
});

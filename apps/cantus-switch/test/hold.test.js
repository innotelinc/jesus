/**
 * Holding a call.
 *
 * Hold is the one call-control button every telephone has, and it was the one
 * this switch did not have: a browser could mute itself, which is not the same
 * thing, and nothing ever played music to the person who was waiting. These
 * tests pin the four things hold means — the waiting party hears music, the
 * party who pressed hold hears silence, neither hears the other, and resuming
 * puts the conversation back on the same answered call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Switch } from '../src/switch.js';
import { peak } from '../src/media.js';

const FRAME_BYTES = 320; // 160 samples at 8 kHz

/** A frame of a steady tone, so "not silence" is unambiguous. */
function tone(hz, amp = 8000, offset = 0) {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i += 1) {
    const value = Math.sin((2 * Math.PI * hz * (offset + i)) / 8000) * amp;
    frame.writeInt16LE(Math.round(value), i * 2);
  }
  return frame;
}

/** A connected call: a browser line and a carrier leg, both answered. */
function connectedCall() {
  const sw = new Switch({
    domain: 'hold.test',
    id: 'switch@hold.test',
    secret: 'hold-test',
    bind: '127.0.0.1:0',
    relayBind: '127.0.0.1:0',
    recordDir: './data/test-recordings',
    prompts: './data/test-prompts',
  });
  sw.setLine({ ext: '101', displayName: 'Demo Owner' });

  const frames = [];
  const socket = {
    closed: false,
    sent: [],
    text: [],
    send: (payload) => frames.push(Buffer.from(payload)),
    sendJson: (message) => socket.text.push(message),
    close: () => {},
    on: () => {},
  };

  const call = { id: 'call-hold', state: 'answered', direction: 'inbound', from: 'voipms', to: '101@hold.test', events: [], legs: [] };
  const session = { id: 'session-carrier' };
  const browser = {
    id: 'leg-web',
    role: 'web',
    ext: '101',
    ws: socket,
    state: 'answered',
    held: false,
    heldAt: 0,
    mohAt: 0,
    received: 0,
    sent: 0,
    rx: undefined,
    rxAt: 0,
  };
  const carrier = {
    id: 'leg-carrier',
    role: 'inbound',
    endpoint: session,
    state: 'answered',
    held: false,
    heldAt: 0,
    mohAt: 0,
    received: 0,
    sent: 0,
    rx: undefined,
    rxAt: 0,
  };
  for (const leg of [browser, carrier]) {
    leg.call = call;
    Object.defineProperty(leg, 'isAnswered', { get() { return this.state === 'answered'; } });
    Object.defineProperty(leg, 'isEnded', { get() { return this.state === 'ended'; } });
    call.legs.push(leg);
  }
  sw.calls.set(call.id, call);
  sw.nextWebMediaAt = 0;

  const legFor = (callId) =>
    sw.calls.get(callId)?.legs.find((leg) => leg.ws === socket && !leg.isEnded);

  return { sw, call, browser, carrier, session, socket, frames, legFor };
}

/** Drive the browser's 20 ms clock, the way the switch's own timer does. */
function runClock(sw, { from = 1_000, ms = 100 } = {}) {
  sw.nextWebMediaAt = from;
  for (let at = from; at < from + ms; at += 10) sw.webMediaTick(at);
}

const allZero = (frame) => frame.every((byte) => byte === 0);

test('hold plays music to the waiting party and silence to the handset', () => {
  const { sw, call, browser, carrier, session, socket, frames } = connectedCall();

  // Before the hold, the caller's voice reaches the line, unfiltered.
  const voice = tone(600);
  sw.onMedia(carrier, voice);
  runClock(sw, { ms: 40 });
  assert.equal(frames.length, 2, 'the line is fed 50 frames a second');
  assert.equal(frames[0].equals(voice), true, 'and what it hears is the caller');

  assert.equal(sw.setHold(browser, true), true);
  assert.deepEqual(socket.text.at(-1), { type: 'held', callId: call.id, held: true });
  assert.equal(call.state, 'answered', 'hold is not a hangup: the call stays up');

  // The waiting party is the caller, so the caller is who hears the music.
  const music = sw.mediaFor(session);
  assert.ok(peak(music) > 200, `the waiting party must hear music, peak ${peak(music)}`);
  assert.notEqual(music.equals(voice), true, 'and not the silence of a dropped bridge');
  // It is music, not a single tone: the melody moves across frames.
  assert.notEqual(sw.mediaFor(session).equals(music), true, 'the music advances');

  // The handset hears nothing at all, which is what holding means.
  frames.length = 0;
  runClock(sw, { from: 2_000, ms: 100 });
  assert.equal(frames.length, 5);
  assert.equal(frames.every(allZero), true, 'a held handset hears silence, not the conversation');
});

test('a held microphone cannot talk to the waiting party', () => {
  const { sw, browser, carrier, session, legFor } = connectedCall();
  sw.onSocketMessage({ sendJson: () => {} }, {}, { type: 'hold', callId: 'call-hold' }, legFor);

  // Somebody speaks into the handset while it is held. The browser keeps
  // sending frames — it is the switch's job to keep them out of the call.
  sw.onMedia(browser, tone(700));

  assert.equal(browser.rx, undefined, 'the frame is not stored as the leg\'s voice');
  const waiting = sw.mediaFor(session);
  assert.equal(peak(waiting) > 0, true, 'the music keeps playing');
  assert.notEqual(waiting.equals(tone(700)), true, 'and never the microphone');

  // The party who is not on hold still reaches nobody either: the handset is
  // fed silence, so the two sides cannot hear each other.
  const opposite = sw.mediaFor(session);
  assert.equal(peak(opposite) > 0, true);
  assert.equal(carrier.rx, undefined);
});

test('resuming returns the conversation on the same answered call', () => {
  const { sw, call, browser, carrier, session, socket, frames, legFor } = connectedCall();
  sw.onMedia(carrier, tone(600));

  sw.onSocketMessage({ sendJson: () => {} }, {}, { type: 'hold', callId: 'call-hold' }, legFor);
  assert.equal(browser.held, true);
  assert.deepEqual(socket.text.at(-1), { held: true, type: 'held', callId: call.id });

  sw.onSocketMessage({ sendJson: () => {} }, {}, { type: 'unhold', callId: 'call-hold' }, legFor);
  assert.equal(browser.held, false);
  assert.deepEqual(socket.text.at(-1), { held: false, type: 'held', callId: call.id });
  assert.equal(call.state, 'answered', 'no re-answer, no second call');
  assert.deepEqual(
    call.events.map((event) => event.type).filter((type) => type === 'call.held' || type === 'call.resumed'),
    ['call.held', 'call.resumed']
  );

  // The caller is heard again immediately, because the caller never stopped.
  frames.length = 0;
  runClock(sw, { from: 3_000, ms: 40 });
  assert.equal(frames.every(allZero), false, 'the line hears the caller after resume');
  assert.equal(frames[0].equals(carrier.rx), true);

  // And the line's own voice reaches the caller again.
  const voice = tone(700);
  sw.onMedia(browser, voice);
  assert.equal(sw.mediaFor(session).equals(voice), true);
});

test('a microphone frame captured before the hold is not replayed after it', () => {
  const { sw, browser, carrier, session, legFor } = connectedCall();
  const beforeHold = tone(700);
  sw.onMedia(browser, beforeHold);
  assert.equal(sw.mediaFor(session).equals(beforeHold), true, 'live audio flows before the hold');

  sw.onSocketMessage({ sendJson: () => {} }, {}, { type: 'hold', callId: 'call-hold' }, legFor);
  sw.onSocketMessage({ sendJson: () => {} }, {}, { type: 'unhold', callId: 'call-hold' }, legFor);

  // Nothing new was said, so the caller must hear silence rather than the last
  // thing they heard before the hold, spoken again out of time.
  const afterResume = sw.mediaFor(session);
  assert.equal(allZero(afterResume), true, 'a stale frame is not a resumption');

  // Only a fresh frame resumes the conversation.
  const fresh = tone(700, 8000, 160);
  sw.onMedia(browser, fresh);
  assert.equal(sw.mediaFor(session).equals(fresh), true);
  assert.equal(carrier.state, 'answered');
});

test('only a connected call can be held, and the switch says so', () => {
  const { sw, call, browser } = connectedCall();
  browser.state = 'ringing';
  const sent = [];
  sw.onSocketMessage({ sendJson: (message) => sent.push(message) }, {}, { type: 'hold', callId: call.id }, () => browser);

  assert.equal(browser.held, false, 'a ringing leg is not put on hold');
  assert.equal(sent.at(-1)?.error, 'not-connected');
  assert.equal(call.state, 'answered');
});

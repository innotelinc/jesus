/**
 * Browser media pacing.
 *
 * A browser leg has no poll tick of its own, so the switch feeds it two ways:
 * a direct push the moment its peer sends a frame, and a 20 ms ticker that
 * keeps silence flowing when the peer is quiet. Both firing for the same tick
 * is the bug this file exists for: the browser then plays real audio
 * interleaved with silence at twice the frame rate, and what the caller hears
 * is chopped noise rather than a voice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
  return { sw, browser, carrier, frames };
}

test('a frame from the carrier reaches the browser exactly once', () => {
  const { sw, carrier, frames } = twoLegs();
  const audio = Buffer.alloc(320, 0x11);

  sw.onMedia(carrier, audio);
  assert.equal(frames.length, 1, 'the direct push delivered it');

  // The ticker runs on the same 20 ms boundary; it must not add a second frame.
  sw.webMediaTick();
  assert.equal(frames.length, 1, 'the ticker did not interleave silence with audio');
  assert.deepEqual(frames[0], audio);
});

test('the ticker still feeds a browser whose peer has gone quiet', () => {
  const { sw, browser, carrier, frames } = twoLegs();
  sw.onMedia(carrier, Buffer.alloc(320, 0x11));
  const before = frames.length;

  // More than one tick later with nothing arriving: silence has to keep flowing,
  // or the browser's player starves and the call goes dead in the silent gaps.
  browser.pushedAt = Date.now() - 100;
  sw.webMediaTick();
  assert.equal(frames.length, before + 1);
});

test('a quiet call keeps the browser fed at the frame rate, not half of it', () => {
  const { sw, browser, frames } = twoLegs();
  browser.pushedAt = 0;
  for (let tick = 0; tick < 10; tick += 1) {
    browser.pushedAt = Date.now() - 50;
    sw.webMediaTick();
  }
  assert.equal(frames.length, 10, 'one frame per tick when the peer is silent');
});
